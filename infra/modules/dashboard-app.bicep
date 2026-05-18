@description('Azure region for the Dashboard container app')
param location string

@description('Name of the Dashboard container app')
param appName string

@description('Resource ID of the Container Apps environment')
param environmentId string

@description('Container image for the Blazor Dashboard')
param containerImage string

@description('Resource ID of the Log Analytics workspace for query access')
param logAnalyticsWorkspaceId string

@description('ACR login server for managed identity pull')
param acrLoginServer string

@description('Resource ID of the user-assigned managed identity for ACR pull')
param dashboardIdentityId string

resource dashboardApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  identity: {
    type: 'SystemAssigned, UserAssigned'
    userAssignedIdentities: {
      '${dashboardIdentityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: environmentId
    configuration: {
      ingress: {
        external: true
        targetPort: 8080
        transport: 'http'
        allowInsecure: false
      }
      registries: [
        {
          server: acrLoginServer
          identity: dashboardIdentityId
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'dashboard'
          image: containerImage
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            {
              name: 'LogAnalytics__WorkspaceId'
              value: logAnalyticsWorkspaceId
            }
          ]
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 3
      }
    }
  }
}

@description('FQDN of the Dashboard container app')
output fqdn string = dashboardApp.properties.configuration.ingress.fqdn

@description('Principal ID of the Dashboard managed identity')
output principalId string = dashboardApp.identity.principalId
