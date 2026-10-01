using './main.bicep'

param location = 'swedencentral'
param baseName = 'ao'
param logRetentionInDays = 30
// Container image to run, set by the deploy workflow from the ACR_NAME repository variable.
param dashboardImage = readEnvironmentVariable('DASHBOARD_IMAGE', '')

// Aggregate analytics org filter (empty = all orgs)
param analyticsOrgId = ''

// Autonomous-agent OTLP relay: enable the /agent-otlp/* endpoints and set raw-batch retention
param agentRelayEnabled = true
param agentOtlpRetentionDays = 7

// Server-side pepper for ingestion API-key HMAC — sourced from GitHub secret INGESTION_KEY_PEPPER
param ingestionKeyPepper = readEnvironmentVariable('INGESTION_KEY_PEPPER', '')

// Dashboard sign-in (Entra ID). Leave DASHBOARD_AUTH_CLIENT_ID unset and the
// dashboard pages are open to anyone with the URL. Set both for any deployment
// reachable from the internet.
param dashboardAuthClientId = readEnvironmentVariable('DASHBOARD_AUTH_CLIENT_ID', '')
param dashboardAuthClientSecret = readEnvironmentVariable('DASHBOARD_AUTH_CLIENT_SECRET', '')
