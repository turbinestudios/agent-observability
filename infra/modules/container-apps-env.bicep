@description('Azure region for the Container Apps environment')
param location string

@description('Name of the Container Apps environment')
param environmentName string

@description('Customer ID of the Log Analytics workspace')
param logAnalyticsWorkspaceCustomerId string

@secure()
@description('Shared key for the Log Analytics workspace')
param logAnalyticsWorkspaceSharedKey string

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsWorkspaceCustomerId
        sharedKey: logAnalyticsWorkspaceSharedKey
      }
    }
  }
}

@description('Resource ID of the Container Apps environment')
output environmentId string = environment.id

@description('Default domain of the Container Apps environment')
output defaultDomain string = environment.properties.defaultDomain
