@description('Azure region for the Application Insights resource')
param location string

@description('Name of the Application Insights resource')
param appInsightsName string

@description('Resource ID of the linked Log Analytics workspace')
param logAnalyticsWorkspaceId string

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalyticsWorkspaceId
  }
}

@description('Connection string for the Application Insights resource')
output connectionString string = appInsights.properties.ConnectionString
