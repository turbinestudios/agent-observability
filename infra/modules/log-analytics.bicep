@description('Azure region for the Log Analytics workspace')
param location string

@description('Name of the Log Analytics workspace')
param workspaceName string

@description('Retention period in days')
param retentionInDays int = 30

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: workspaceName
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: retentionInDays
  }
}

@description('Resource ID of the Log Analytics workspace')
output workspaceId string = workspace.id

@description('Customer ID (workspace ID) for Log Analytics')
output workspaceCustomerId string = workspace.properties.customerId

@description('Primary shared key for Log Analytics')
output workspaceSharedKey string = workspace.listKeys().primarySharedKey
