using './main.bicep'

param location = 'swedencentral'
param baseName = 'agent-obs'
param logRetentionInDays = 30
param otelCollectorImage = 'otel/opentelemetry-collector-contrib:0.102.0'
param dashboardImage = 'mcr.microsoft.com/dotnet/samples:aspnetapp' // Placeholder until Phase 3 builds the real image
param azureMonitorConnectionString = readEnvironmentVariable('AZURE_MONITOR_CONNECTION_STRING', '')
param otelCollectorConfig = loadTextContent('../src/collector/otel-collector-config.yaml')
