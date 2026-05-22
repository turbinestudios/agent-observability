@description('Azure region for the AI resource')
param location string

@description('Name of the AI Foundry project')
param projectName string

@description('Name of the model deployment')
param deploymentName string = 'gpt-4o'

@description('Model name to deploy')
param modelName string = 'gpt-4o'

@description('Model version to deploy')
param modelVersion string = '2024-11-20'

// AI Services account (provides the underlying compute for model inference)
resource aiServices 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: '${projectName}-aiservices'
  location: location
  kind: 'AIServices'
  sku: {
    name: 'S0'
  }
  properties: {
    customSubDomainName: '${projectName}-aiservices'
    publicNetworkAccess: 'Enabled'
  }
}

// AI Foundry Hub (required parent for projects)
resource aiHub 'Microsoft.MachineLearningServices/workspaces@2024-10-01' = {
  name: '${projectName}-hub'
  location: location
  kind: 'Hub'
  sku: {
    name: 'Basic'
    tier: 'Basic'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    friendlyName: '${projectName}-hub'
    publicNetworkAccess: 'Enabled'
  }
}

// AI Foundry project (Azure Machine Learning workspace)
resource aiProject 'Microsoft.MachineLearningServices/workspaces@2024-10-01' = {
  name: projectName
  location: location
  kind: 'Project'
  sku: {
    name: 'Basic'
    tier: 'Basic'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    friendlyName: projectName
    hubResourceId: aiHub.id
    publicNetworkAccess: 'Enabled'
  }
}

// Connection from AI Foundry project to AI Services
resource aiServicesConnection 'Microsoft.MachineLearningServices/workspaces/connections@2024-10-01' = {
  parent: aiProject
  name: 'aiservices-connection'
  properties: {
    category: 'AzureOpenAI'
    authType: 'AAD'
    target: aiServices.properties.endpoint
    metadata: {
      ApiType: 'Azure'
      ResourceId: aiServices.id
    }
  }
}

// Model deployment on the AI Services account
resource modelDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: aiServices
  name: deploymentName
  sku: {
    name: 'Standard'
    capacity: 10
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: modelName
      version: modelVersion
    }
  }
}

@description('AI Foundry project endpoint (used by Azure.AI.Projects SDK)')
output endpoint string = 'https://${projectName}.services.ai.azure.com'

@description('Resource ID of the AI Foundry project (for RBAC scoping)')
output projectId string = aiProject.id

@description('Name of the deployed model')
output deploymentName string = modelDeployment.name

@description('Principal ID of the AI Foundry project managed identity')
output projectPrincipalId string = aiProject.identity.principalId
