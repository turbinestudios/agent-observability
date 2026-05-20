<#
.SYNOPSIS
    VS Code Copilot OTel global environment setup (Windows).

.DESCRIPTION
    Sets persistent User-scope environment variables for OTLP authentication
    and global resource attributes (user.email).

    WHAT IT WRITES:
      [User] OTEL_EXPORTER_OTLP_HEADERS = Authorization=Basic base64("otlp:<key>")
      [User] OTEL_RESOURCE_ATTRIBUTES_GLOBAL = user.email=<email>

    HOW TO UNDO:
      .\setup-global.ps1 -Uninstall

.PARAMETER Email
    Developer's email address (e.g. alice@example.com).

.PARAMETER ApiKey
    API key for the OTel collector. Will be formatted as Basic auth header internally.

.PARAMETER Uninstall
    Remove the environment variables set by this script.

.EXAMPLE
    .\setup-global.ps1 -Email alice@example.com -ApiKey "my-secret-key"

.EXAMPLE
    .\setup-global.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [Parameter()]
    [string]$Email,

    [Parameter()]
    [string]$ApiKey,

    [Parameter()]
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

# --- Uninstall ----------------------------------------------------------------

if ($Uninstall) {
    Write-Host "Removing OTel global environment variables..."
    [Environment]::SetEnvironmentVariable('OTEL_EXPORTER_OTLP_HEADERS', $null, 'User')
    [Environment]::SetEnvironmentVariable('OTEL_RESOURCE_ATTRIBUTES_GLOBAL', $null, 'User')
    Write-Host "Done. Restart VS Code for changes to take effect."
    return
}

# --- Interactive prompts if not provided --------------------------------------

if (-not $Email) {
    $Email = Read-Host -Prompt "Developer email"
}
if (-not $ApiKey) {
    $secureKey = Read-Host -Prompt "API key for the OTel collector" -AsSecureString
    $ApiKey = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
    )
}

# --- Validation ---------------------------------------------------------------

if ([string]::IsNullOrWhiteSpace($Email)) {
    throw "Email cannot be empty."
}
if ($Email -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') {
    throw "Invalid email format: $Email"
}
if ([string]::IsNullOrWhiteSpace($ApiKey)) {
    throw "API key cannot be empty."
}

# Format auth header: Authorization=Basic base64("otlp:<key>")
$encodedCredential = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("otlp:$ApiKey"))
$AuthHeader = "Authorization=Basic $encodedCredential"

# --- Set environment variables ------------------------------------------------

[Environment]::SetEnvironmentVariable('OTEL_EXPORTER_OTLP_HEADERS', $AuthHeader, 'User')
[Environment]::SetEnvironmentVariable('OTEL_RESOURCE_ATTRIBUTES_GLOBAL', "user.email=$Email", 'User')

Write-Host "Done. Set User-scope environment variables:"
Write-Host "  OTEL_EXPORTER_OTLP_HEADERS = Authorization=Basic [hidden]"
Write-Host "  OTEL_RESOURCE_ATTRIBUTES_GLOBAL = user.email=$Email"
Write-Host ""
Write-Host "Restart VS Code for changes to take effect."
