targetScope = 'resourceGroup'

@description('Azure region for all resources')
param location string

@description('Base name for all resources')
param baseName string

@description('Retention period in days for Log Analytics')
param logRetentionInDays int = 30

@description('Container image for the OTel Collector')
param otelCollectorImage string = 'otel/opentelemetry-collector-contrib:latest'

@description('Container image for the Blazor Dashboard')
param dashboardImage string

@description('OTel Collector configuration YAML content')
param otelCollectorConfig string

@secure()
@description('htpasswd entry for OTel Collector basicauth (format: username:bcrypt-hash)')
param otelBasicAuthHtpasswd string

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

// Step 1.1 — Log Analytics Workspace
module logAnalytics 'modules/log-analytics.bicep' = {
  params: {
    location: location
    workspaceName: 'log-${baseName}'
    retentionInDays: logRetentionInDays
  }
}

// Application Insights (provides connection string for OTel exporter)
module appInsights 'modules/app-insights.bicep' = {
  params: {
    location: location
    appInsightsName: 'appi-${baseName}'
    logAnalyticsWorkspaceId: logAnalytics.outputs.workspaceId
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

// Step 1.3 — Container App: OTel Collector
module otelCollector 'modules/otel-collector.bicep' = {
  params: {
    location: location
    appName: 'ca-${baseName}-otel-collector'
    environmentId: containerAppsEnv.outputs.environmentId
    containerImage: otelCollectorImage
    azureMonitorConnectionString: appInsights.outputs.connectionString
    otelCollectorConfig: otelCollectorConfig
    basicAuthHtpasswd: otelBasicAuthHtpasswd
  }
}

// Step 1.4 — Container App: Blazor Dashboard
module dashboard 'modules/dashboard-app.bicep' = {
  params: {
    location: location
    appName: 'ca-${baseName}-dashboard'
    environmentId: containerAppsEnv.outputs.environmentId
    containerImage: dashboardImage
    logAnalyticsWorkspaceId: logAnalytics.outputs.workspaceCustomerId
    acrLoginServer: acr.outputs.loginServer
    dashboardIdentityId: dashboardIdentity.id
  }
  dependsOn: [dashboardAcrPullRole]
}

// Step 1.5 — Role Assignments

resource logAnalyticsWorkspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: 'log-${baseName}'
  dependsOn: [logAnalytics]
}

// Monitoring Metrics Publisher role for OTel Collector
resource otelCollectorMonitoringRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, 'ca-${baseName}-otel-collector', '3913510d-42f4-4e42-8a64-420c390055eb')
  scope: logAnalyticsWorkspace
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '3913510d-42f4-4e42-8a64-420c390055eb')
    principalId: otelCollector.outputs.principalId
    principalType: 'ServicePrincipal'
  }
}

// Log Analytics Reader role for Dashboard
resource dashboardReaderRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, 'ca-${baseName}-dashboard', '73c42c96-874c-492b-b04d-ab87d138a893')
  scope: logAnalyticsWorkspace
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '73c42c96-874c-492b-b04d-ab87d138a893')
    principalId: dashboard.outputs.principalId
    principalType: 'ServicePrincipal'
  }
}

// Outputs
@description('FQDN of the OTel Collector endpoint')
output otelCollectorFqdn string = otelCollector.outputs.fqdn

@description('FQDN of the Dashboard')
output dashboardFqdn string = dashboard.outputs.fqdn

@description('Log Analytics Workspace ID')
output logAnalyticsWorkspaceId string = logAnalytics.outputs.workspaceId

@description('ACR Login Server')
output acrLoginServer string = acr.outputs.loginServer
