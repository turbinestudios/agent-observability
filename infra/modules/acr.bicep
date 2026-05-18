@description('Azure region for the container registry')
param location string

@description('Name of the Azure Container Registry')
param registryName string

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
  }
}

@description('Login server of the ACR')
output loginServer string = acr.properties.loginServer

@description('Resource ID of the ACR')
output id string = acr.id
