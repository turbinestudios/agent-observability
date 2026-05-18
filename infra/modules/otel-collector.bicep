@description('Azure region for the OTel Collector container app')
param location string

@description('Name of the OTel Collector container app')
param appName string

@description('Resource ID of the Container Apps environment')
param environmentId string

@description('Container image for the OTel Collector')
param containerImage string = 'otel/opentelemetry-collector-contrib:latest'

@secure()
@description('Azure Monitor connection string for the OTel exporter')
param azureMonitorConnectionString string

@secure()
@description('OTel Collector configuration YAML content')
param otelCollectorConfig string

resource collectorApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    managedEnvironmentId: environmentId
    configuration: {
      ingress: {
        external: true
        targetPort: 4318
        transport: 'http'
        allowInsecure: false
      }
      secrets: [
        {
          name: 'azure-monitor-connection-string'
          value: azureMonitorConnectionString
        }
        {
          name: 'otel-collector-config'
          value: otelCollectorConfig
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'otel-collector'
          image: containerImage
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            {
              name: 'AZURE_MONITOR_CONNECTION_STRING'
              secretRef: 'azure-monitor-connection-string'
            }
          ]
          volumeMounts: [
            {
              volumeName: 'otel-config'
              mountPath: '/etc/otelcol-contrib'
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 3
      }
      volumes: [
        {
          name: 'otel-config'
          storageType: 'Secret'
          secrets: [
            {
              secretRef: 'otel-collector-config'
              path: 'config.yaml'
            }
          ]
        }
      ]
    }
  }
}

@description('FQDN of the OTel Collector container app')
output fqdn string = collectorApp.properties.configuration.ingress.fqdn

@description('Principal ID of the OTel Collector managed identity')
output principalId string = collectorApp.identity.principalId
