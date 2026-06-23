@description('Azure region for the Key Vault')
param location string

@description('Name of the Key Vault')
param keyVaultName string

@secure()
@description('Server-side pepper for ingestion API-key HMAC, stored as a Key Vault secret')
param ingestionKeyPepper string

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: tenant().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
  }
}

resource ingestionKeyPepperSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'ingestion-key-pepper'
  properties: {
    value: ingestionKeyPepper
  }
}

@description('Key Vault resource ID')
output keyVaultId string = keyVault.id

@description('Key Vault URI')
output keyVaultUri string = keyVault.properties.vaultUri
