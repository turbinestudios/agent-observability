targetScope = 'resourceGroup'

@description('Azure region for all resources')
param location string

@description('Base name for all resources')
param baseName string

@description('Retention period in days for Log Analytics')
param logRetentionInDays int = 30

@description('Container image for the Blazor Dashboard')
param dashboardImage string

@secure()
@description('Server-side pepper for ingestion API-key HMAC (Ingestion:KeyPepper), stored in Key Vault and wired to the dashboard')
param ingestionKeyPepper string

@description('Organization id filter for aggregate analytics (Analytics:OrgId). Empty = all orgs.')
param analyticsOrgId string = ''

@description('Enable the autonomous-agent OTLP relay endpoints on the dashboard')
param agentRelayEnabled bool = true

@description('Retention in days for raw autonomous-agent OTLP batches before lifecycle deletion')
param agentOtlpRetentionDays int = 7

@description('Client id of the Entra ID app registration for dashboard sign-in. Empty turns sign-in off.')
param dashboardAuthClientId string = ''

@secure()
@description('Client secret of the dashboard sign-in app registration')
param dashboardAuthClientSecret string = ''

// Azure Container Registry
module acr 'modules/acr.bicep' = {
  params: {
    location: location
    registryName: replace('acr${baseName}', '-', '')
  }
}

// User-assigned managed identity for ACR pull (avoids chicken-and-egg with system identity)
resource dashboardIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${baseName}-dashboard'
  location: location
}

// AcrPull role for Dashboard identity (assigned before Container App creation)
resource acrResource 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: replace('acr${baseName}', '-', '')
  dependsOn: [acr]
}

resource dashboardAcrPullRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, 'id-${baseName}-dashboard', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  scope: acrResource
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
    principalId: dashboardIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Key Vault for secrets
module keyVault 'modules/key-vault.bicep' = {
  params: {
    location: location
    keyVaultName: 'kv-${baseName}-${uniqueString(resourceGroup().id)}'
    ingestionKeyPepper: ingestionKeyPepper
  }
}

// Step 1.1 — Log Analytics Workspace
module logAnalytics 'modules/log-analytics.bicep' = {
  params: {
    location: location
    workspaceName: 'log-${baseName}'
    retentionInDays: logRetentionInDays
  }
}

// Step 1.2 — Container Apps Environment
module containerAppsEnv 'modules/container-apps-env.bicep' = {
  params: {
    location: location
    environmentName: 'cae-${baseName}'
    logAnalyticsWorkspaceCustomerId: logAnalytics.outputs.workspaceCustomerId
    logAnalyticsWorkspaceName: 'log-${baseName}'
  }
}

// Storage Account for workflow configuration (Table Storage) and the agent OTLP relay (Blob Storage)
module storageAccount 'modules/storage-account.bicep' = {
  params: {
    location: location
    storageAccountName: replace('st${baseName}${uniqueString(resourceGroup().id)}', '-', '')
    agentOtlpRetentionDays: agentOtlpRetentionDays
  }
}

// Step 1.4 — Container App: Blazor Dashboard
module dashboard 'modules/dashboard-app.bicep' = {
  params: {
    location: location
    appName: 'ca-${baseName}-dashboard'
    environmentId: containerAppsEnv.outputs.environmentId
    containerImage: dashboardImage
    acrLoginServer: acr.outputs.loginServer
    dashboardIdentityId: dashboardIdentity.id
    storageTableEndpoint: storageAccount.outputs.tableEndpoint
    storageBlobEndpoint: storageAccount.outputs.blobEndpoint
    ingestionKeyPepper: ingestionKeyPepper
    analyticsOrgId: analyticsOrgId
    agentRelayEnabled: agentRelayEnabled
    authClientId: dashboardAuthClientId
    authClientSecret: dashboardAuthClientSecret
  }
  dependsOn: [dashboardAcrPullRole]
}

// Step 1.5 — Role Assignments

// Storage Table Data Contributor role for Dashboard identity
resource storageAccountResource 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: replace('st${baseName}${uniqueString(resourceGroup().id)}', '-', '')
  dependsOn: [storageAccount]
}

resource dashboardTableDataRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, 'ca-${baseName}-dashboard', '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3')
  scope: storageAccountResource
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3')
    principalId: dashboard.outputs.principalId
    principalType: 'ServicePrincipal'
  }
}

// Storage Blob Data Contributor role for Dashboard identity (agent OTLP relay read/write)
resource dashboardBlobDataRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, 'ca-${baseName}-dashboard', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  scope: storageAccountResource
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    principalId: dashboard.outputs.principalId
    principalType: 'ServicePrincipal'
  }
}

// Outputs
@description('FQDN of the Dashboard')
output dashboardFqdn string = dashboard.outputs.fqdn

@description('ACR Login Server')
output acrLoginServer string = acr.outputs.loginServer

@description('Key Vault URI')
output keyVaultUri string = keyVault.outputs.keyVaultUri

@description('Storage Account Table Endpoint')
output storageTableEndpoint string = storageAccount.outputs.tableEndpoint

@description('Storage Account Blob Endpoint')
output storageBlobEndpoint string = storageAccount.outputs.blobEndpoint
