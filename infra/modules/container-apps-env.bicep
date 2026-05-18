@description('Azure region for the Container Apps environment')
param location string

@description('Name of the Container Apps environment')
param environmentName string

@description('Customer ID of the Log Analytics workspace')
param logAnalyticsWorkspaceCustomerId string

@description('Name of the Log Analytics workspace')
param logAnalyticsWorkspaceName string

resource logAnalyticsWorkspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: logAnalyticsWorkspaceName
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsWorkspaceCustomerId
        sharedKey: logAnalyticsWorkspace.listKeys().primarySharedKey
      }
    }
  }
}

@description('Resource ID of the Container Apps environment')
output environmentId string = environment.id

@description('Default domain of the Container Apps environment')
output defaultDomain string = environment.properties.defaultDomain
