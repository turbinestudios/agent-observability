#Requires -Version 5.1
<#
.SYNOPSIS
    Generates and provisions a new Agent Observability ingestion API key, then prints the
    plaintext token to hand to a developer for the VS Code extension.

.DESCRIPTION
    Uses your current Azure CLI login (`az login`) to:

      1. Discover the Key Vault and Storage Account deployed by infra/main.bicep in the target
         resource group (or use the names you pass explicitly).
      2. Read the server-side HMAC pepper from Key Vault secret 'ingestion-key-pepper' — the same
         value the dashboard reads as Ingestion:KeyPepper.
      3. Mint a token 'aoa_<keyId>_<secret>' (keyId = 5 random bytes, secret = 32 random bytes).
      4. Compute SecretHashHex = HMAC-SHA256(pepper, secret) as lowercase hex, matching the
         dashboard's IngestionAuthenticator.ComputeSecretHashHex exactly.
      5. Write the key record (PartitionKey=apikey, RowKey=keyId, OrgId, SecretHashHex, Algo,
         Status) to the 'IngestionApiKeys' table. The plaintext key is NEVER stored or logged —
         only its hash is persisted.
      6. Print the plaintext token once. Give it to the developer; they run
         "Agent Observability: Set Organization API Key" in VS Code and paste it.

.PARAMETER ResourceGroup
    Resource group that holds the deployed infrastructure. Default: 'rg-agent-observability'.

.PARAMETER OrgId
    Organization id stamped on every aggregate uploaded with this key. Must match the dashboard's
    Analytics:OrgId when that filter is set (empty filter = all orgs). Default: 'default-org'.

.PARAMETER BaseName
    The infra 'baseName' used to discover resources by prefix (kv-<baseName>, st<baseName>).
    Default: 'ao'. Ignored when -KeyVaultName / -StorageAccountName are supplied.

.PARAMETER KeyVaultName
    Explicit Key Vault name. Skips auto-discovery when provided.

.PARAMETER StorageAccountName
    Explicit Storage Account name. Skips auto-discovery when provided.

.PARAMETER KeyVaultSecretName
    Name of the pepper secret in Key Vault. Default: 'ingestion-key-pepper'.

.PARAMETER TableName
    Azure Table that holds key records. Default: 'IngestionApiKeys'.

.PARAMETER Label
    Optional human description stored alongside the key (e.g. "Alice — laptop").

.PARAMETER Status
    Initial key status. Default: 'active'. Anything other than 'active' disables the key.

.PARAMETER SubscriptionId
    Optional subscription to switch to before provisioning.

.EXAMPLE
    ./New-IngestionApiKey.ps1 -OrgId 'contoso' -Label 'Alice laptop'

    Mints a key for org 'contoso', stores its hash, and prints the token to share.

.NOTES
    Required RBAC on the signed-in user:
      * 'Key Vault Secrets User' on the Key Vault (to read the pepper).
      * 'Storage Table Data Contributor' on the Storage Account (to write the key record).

    The plaintext token is shown exactly once and cannot be recovered later — only its hash is
    stored. To revoke a key, set its row's Status to 'revoked' (or delete the row).
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$ResourceGroup = 'rg-agent-observability',
    [string]$OrgId = 'default-org',
    [string]$BaseName = 'ao',
    [string]$KeyVaultName,
    [string]$StorageAccountName,
    [string]$KeyVaultSecretName = 'ingestion-key-pepper',
    [string]$TableName = 'IngestionApiKeys',
    [string]$Label,
    [ValidateSet('active', 'revoked')]
    [string]$Status = 'active',
    [string]$SubscriptionId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-LastExit {
    param([Parameter(Mandatory)][string]$Action)
    if ($LASTEXITCODE -ne 0) {
        throw "Azure CLI failed while trying to $Action (exit code $LASTEXITCODE). See the error above."
    }
}

function New-RandomHex {
    param([Parameter(Mandatory)][int]$ByteCount)
    $bytes = New-Object 'System.Byte[]' $ByteCount
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return ([System.BitConverter]::ToString($bytes) -replace '-').ToLowerInvariant()
}

function Get-SecretHashHex {
    # Mirrors IngestionAuthenticator.ComputeSecretHashHex: HMAC-SHA256(UTF8(pepper), UTF8(secret))
    # rendered as lowercase hex. The HMAC message is the secret segment ONLY.
    param(
        [Parameter(Mandatory)][string]$Pepper,
        [Parameter(Mandatory)][string]$Secret
    )
    $hmac = [System.Security.Cryptography.HMACSHA256]::new([System.Text.Encoding]::UTF8.GetBytes($Pepper))
    try {
        $hash = $hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Secret))
    }
    finally {
        $hmac.Dispose()
    }
    return ([System.BitConverter]::ToString($hash) -replace '-').ToLowerInvariant()
}

# --- Preflight -----------------------------------------------------------------------------------

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw "Azure CLI ('az') was not found on PATH. Install it and run 'az login' first."
}

$account = az account show -o json 2>$null | ConvertFrom-Json
if (-not $account) {
    throw "You are not logged in to Azure CLI. Run 'az login' and try again."
}

if ($SubscriptionId) {
    az account set --subscription $SubscriptionId
    Assert-LastExit "switch to subscription '$SubscriptionId'"
    $account = az account show -o json | ConvertFrom-Json
}

Write-Host "Signed in as : $($account.user.name)" -ForegroundColor DarkGray
Write-Host "Subscription : $($account.name) ($($account.id))" -ForegroundColor DarkGray
Write-Host "Resource grp : $ResourceGroup" -ForegroundColor DarkGray

# --- Resolve resources ---------------------------------------------------------------------------

if (-not $KeyVaultName) {
    $KeyVaultName = az keyvault list --resource-group $ResourceGroup `
        --query "[?starts_with(name, 'kv-$BaseName')].name | [0]" -o tsv
    Assert-LastExit "list Key Vaults in '$ResourceGroup'"
    if (-not $KeyVaultName) {
        throw "Could not find a Key Vault named 'kv-$BaseName*' in '$ResourceGroup'. Pass -KeyVaultName explicitly."
    }
}

if (-not $StorageAccountName) {
    $StorageAccountName = az storage account list --resource-group $ResourceGroup `
        --query "[?starts_with(name, 'st$BaseName')].name | [0]" -o tsv
    Assert-LastExit "list Storage Accounts in '$ResourceGroup'"
    if (-not $StorageAccountName) {
        throw "Could not find a Storage Account named 'st$BaseName*' in '$ResourceGroup'. Pass -StorageAccountName explicitly."
    }
}

Write-Host "Key Vault    : $KeyVaultName" -ForegroundColor DarkGray
Write-Host "Storage acct : $StorageAccountName" -ForegroundColor DarkGray

# --- Read the pepper (never printed) -------------------------------------------------------------

$pepper = az keyvault secret show --vault-name $KeyVaultName --name $KeyVaultSecretName --query value -o tsv
Assert-LastExit "read secret '$KeyVaultSecretName' from Key Vault '$KeyVaultName'"
if ([string]::IsNullOrWhiteSpace($pepper)) {
    throw "Key Vault secret '$KeyVaultSecretName' is empty. Cannot compute a valid key hash."
}

# --- Mint the token and compute the stored hash --------------------------------------------------

$keyId = New-RandomHex -ByteCount 5     # 10 hex chars, public lookup handle (no underscore)
$secret = New-RandomHex -ByteCount 32   # 64 hex chars, >= 256 bits of entropy
$token = "aoa_${keyId}_${secret}"
$secretHashHex = Get-SecretHashHex -Pepper $pepper -Secret $secret
$createdAt = (Get-Date).ToUniversalTime().ToString('o')

# --- Persist the key record (hash only) ----------------------------------------------------------

$entity = @(
    'PartitionKey=apikey'
    "RowKey=$keyId"
    "OrgId=$OrgId"
    "SecretHashHex=$secretHashHex"
    'Algo=HMAC-SHA256'
    "Status=$Status"
    "CreatedAt=$createdAt"
)
if ($Label) { $entity += "Label=$Label" }

if ($PSCmdlet.ShouldProcess("$TableName ($StorageAccountName)", "Insert ingestion API key '$keyId' for org '$OrgId'")) {
    az storage entity insert `
        --account-name $StorageAccountName `
        --table-name $TableName `
        --auth-mode login `
        --if-exists fail `
        --entity $entity `
        --output none
    Assert-LastExit "insert the key record into table '$TableName'"

    Write-Host ''
    Write-Host 'API key provisioned.' -ForegroundColor Green
    Write-Host "  keyId  : $keyId"
    Write-Host "  orgId  : $OrgId"
    Write-Host "  status : $Status"
    Write-Host ''
    Write-Host '  Give this token to the developer (shown ONCE, not recoverable):' -ForegroundColor Yellow
    Write-Host "  $token" -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  In VS Code: run "Agent Observability: Set Organization API Key", paste the token,'
    Write-Host '  then turn on Cloud sharing in the Sync view.'

    [pscustomobject]@{
        KeyId         = $keyId
        OrgId         = $OrgId
        Status        = $Status
        Token         = $token
        SecretHashHex = $secretHashHex
        KeyVault      = $KeyVaultName
        StorageAccount = $StorageAccountName
        Table         = $TableName
    }
}
