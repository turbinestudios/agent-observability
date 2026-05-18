using './main.bicep'

param location = 'swedencentral'
param baseName = 'ao'
param logRetentionInDays = 30
param otelCollectorImage = 'otel/opentelemetry-collector-contrib:0.102.0'
param dashboardImage = 'mcr.microsoft.com/dotnet/samples:aspnetapp' // Placeholder until Phase 3 builds the real image
param otelCollectorConfig = loadTextContent('../src/collector/otel-collector-config.yaml')
