@description('Azure region for the Dashboard container app')
param location string

@description('Name of the Dashboard container app')
param appName string

@description('Resource ID of the Container Apps environment')
param environmentId string

@description('Container image for the Blazor Dashboard')
param containerImage string

@description('ACR login server for managed identity pull')
param acrLoginServer string

@description('Resource ID of the user-assigned managed identity for ACR pull')
param dashboardIdentityId string

@description('Table service endpoint for Azure Table Storage')
param storageTableEndpoint string

@description('Blob service endpoint for Azure Blob Storage (autonomous-agent OTLP relay)')
param storageBlobEndpoint string

@description('Enable the autonomous-agent OTLP relay endpoints (AgentRelay:Enabled)')
param agentRelayEnabled bool = true

@secure()
@description('Server-side pepper for ingestion API-key HMAC (Ingestion:KeyPepper), wired as a Container App secret')
param ingestionKeyPepper string

@description('Organization id filter for aggregate analytics (Analytics:OrgId). Empty = all orgs.')
param analyticsOrgId string = ''

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
      secrets: [
        {
          name: 'ingestion-key-pepper'
          value: ingestionKeyPepper
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
              name: 'Storage__TableEndpoint'
              value: storageTableEndpoint
            }
            {
              name: 'Storage__BlobEndpoint'
              value: storageBlobEndpoint
            }
            {
              name: 'Ingestion__Enabled'
              value: 'true'
            }
            {
              name: 'Ingestion__KeyPepper'
              secretRef: 'ingestion-key-pepper'
            }
            {
              name: 'AgentRelay__Enabled'
              value: string(agentRelayEnabled)
            }
            {
              name: 'Analytics__OrgId'
              value: analyticsOrgId
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
