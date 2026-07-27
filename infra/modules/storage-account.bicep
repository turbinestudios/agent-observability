@description('Azure region for the Storage Account')
param location string

@description('Name of the Storage Account')
param storageAccountName string

@description('Retention in days for raw autonomous-agent OTLP batches before lifecycle deletion')
param agentOtlpRetentionDays int = 7

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
  }
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
}

// Aggregate ingestion tables (also created at runtime via EnsureTablesExistAsync; declared here for explicit IaC)
resource ingestionAggregatesTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'IngestionAggregates'
}

resource ingestionSyncStatusTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'IngestionSyncStatus'
}

resource ingestionApiKeysTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'IngestionApiKeys'
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
}

// Raw autonomous-agent OTLP batches pushed by the Copilot CLI agent and pulled by the extension
// (also created at runtime via EnsureContainerExistsAsync; declared here for explicit IaC).
resource agentOtlpRawContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'agent-otlp-raw'
  properties: {
    publicAccess: 'None'
  }
}

// Bound the relay's storage: delete raw batches once they age past the retention window.
resource lifecyclePolicy 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storageAccount
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'expire-agent-otlp-raw'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: ['blockBlob']
              prefixMatch: ['${agentOtlpRawContainer.name}/']
            }
            actions: {
              baseBlob: {
                delete: {
                  daysAfterModificationGreaterThan: agentOtlpRetentionDays
                }
              }
            }
          }
        }
      ]
    }
  }
}

@description('Storage Account resource ID')
output storageAccountId string = storageAccount.id

@description('Storage Account name')
output storageAccountName string = storageAccount.name

@description('Table service endpoint')
output tableEndpoint string = storageAccount.properties.primaryEndpoints.table

@description('Blob service endpoint')
output blobEndpoint string = storageAccount.properties.primaryEndpoints.blob

