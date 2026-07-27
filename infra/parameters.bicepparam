using './main.bicep'

param location = 'swedencentral'
param baseName = 'ao'
param logRetentionInDays = 30
param dashboardImage = 'acrao.azurecr.io/dashboard:latest'

// Aggregate analytics org filter (empty = all orgs)
param analyticsOrgId = ''

// Autonomous-agent OTLP relay: enable the /agent-otlp/* endpoints and set raw-batch retention
param agentRelayEnabled = true
param agentOtlpRetentionDays = 7

// Server-side pepper for ingestion API-key HMAC — sourced from GitHub secret INGESTION_KEY_PEPPER
param ingestionKeyPepper = readEnvironmentVariable('INGESTION_KEY_PEPPER', '')
