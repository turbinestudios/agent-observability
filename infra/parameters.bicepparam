using './main.bicep'

param location = 'swedencentral'
param baseName = 'ao'
param logRetentionInDays = 30
param otelCollectorImage = 'otel/opentelemetry-collector-contrib:0.102.0'
param dashboardImage = 'acrao.azurecr.io/dashboard:latest'
param otelCollectorConfig = loadTextContent('../src/collector/otel-collector-config.yaml')
