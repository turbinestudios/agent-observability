using AgentObservability.Dashboard.Components;
using AgentObservability.Dashboard.Models;
using AgentObservability.Dashboard.Services;
using AgentObservability.Dashboard.Services.Analytics;
using AgentObservability.Dashboard.Services.Ingestion;
using AgentObservability.Dashboard;
using Azure.Data.Tables;
using Azure.Identity;
using Azure.Storage.Blobs;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();

builder.Services.AddScoped<Radzen.TooltipService>();
builder.Services.AddScoped<Radzen.DialogService>();
builder.Services.AddScoped<Radzen.NotificationService>();
builder.Services.AddScoped<Radzen.ContextMenuService>();

builder.Services.Configure<LogAnalyticsOptions>(builder.Configuration.GetSection(LogAnalyticsOptions.SectionName));
builder.Services.AddSingleton<LogAnalyticsService>();

// Phase 9 (privacy-first refactor): web UX split. ExposeRawSessionDetail defaults to false so the
// org dashboard renders aggregate views only; raw per-session/per-interaction detail lives in the
// VS Code 'Agent Observability (Local)' extension. Flip to true for a one-release rollback.
builder.Services.Configure<WebUxOptions>(builder.Configuration.GetSection(WebUxOptions.SectionName));

// Phase 5: Alert Engine & Workflow Deviation Detection
builder.Services.Configure<AlertEngineOptions>(builder.Configuration.GetSection(AlertEngineOptions.SectionName));
builder.Services.AddSingleton<WorkflowDeviationDetector>();
builder.Services.AddHttpClient("AlertEngine");
builder.Services.AddHostedService<AlertEngine>();

// Phase 6: Workflow Management (Azure Table Storage)
var storageTableEndpoint = builder.Configuration["Storage:TableEndpoint"];
if (!string.IsNullOrEmpty(storageTableEndpoint))
{
    builder.Services.AddSingleton(new TableServiceClient(new Uri(storageTableEndpoint), new DefaultAzureCredential()));
}
else
{
    // Fallback to connection string for local development (Azurite)
    var storageConnectionString = builder.Configuration["Storage:ConnectionString"] ?? "UseDevelopmentStorage=true";
    builder.Services.AddSingleton(new TableServiceClient(storageConnectionString));
}
builder.Services.AddSingleton<WorkflowManagementService>();

// Phase 7: Custom Dashboards
builder.Services.AddSingleton<DashboardService>();
builder.Services.AddScoped<WidgetQueryService>();

// Phase 8: AI-powered KQL generation
builder.Services.Configure<AzureAIOptions>(builder.Configuration.GetSection(AzureAIOptions.SectionName));
builder.Services.AddSingleton<EmbeddingService>();
// Phase 10 (privacy-first refactor): AI query generation now targets the aggregate-only model and
// is guarded so it cannot reference raw telemetry. AiQuery:Enabled (default true) is the rollback
// switch; when false the generate/teaching flows short-circuit and the assistant UI shows a
// disabled state.
builder.Services.Configure<AiQueryOptions>(builder.Configuration.GetSection(AiQueryOptions.SectionName));
builder.Services.AddScoped<KqlGenerationService>();

// Phase 9: AI Learnings (Azure Blob Storage)
var storageBlobEndpoint = builder.Configuration["Storage:BlobEndpoint"];
if (!string.IsNullOrEmpty(storageBlobEndpoint))
{
    builder.Services.AddSingleton(new BlobServiceClient(new Uri(storageBlobEndpoint), new DefaultAzureCredential()));
}
else
{
    var storageConnectionString = builder.Configuration["Storage:ConnectionString"] ?? "UseDevelopmentStorage=true";
    builder.Services.AddSingleton(new BlobServiceClient(storageConnectionString));
}
builder.Services.AddSingleton<LearningService>();

// Phase 6 (privacy-first refactor): Cloud Ingestion API.
builder.Services.Configure<IngestionOptions>(builder.Configuration.GetSection(IngestionOptions.SectionName));

// Use the Table-backed API key store when a storage endpoint/connection string is configured,
// otherwise fall back to the config-backed store (dev/local). TableServiceClient is always
// registered above, but we only trust the Table store when storage is actually wired.
var ingestionTableConfigured =
    !string.IsNullOrEmpty(builder.Configuration["Storage:TableEndpoint"]) ||
    !string.IsNullOrEmpty(builder.Configuration["Storage:ConnectionString"]);

if (ingestionTableConfigured)
{
    builder.Services.AddSingleton<TableApiKeyStore>();
    builder.Services.AddSingleton<IApiKeyStore>(sp => sp.GetRequiredService<TableApiKeyStore>());
}
else
{
    builder.Services.AddSingleton<IApiKeyStore, ConfigApiKeyStore>();
}

builder.Services.AddSingleton<IngestionAuthenticator>();
builder.Services.AddSingleton<AggregateBatchValidator>();
builder.Services.AddSingleton<TableAggregateStore>();
builder.Services.AddSingleton<IAggregateStore>(sp => sp.GetRequiredService<TableAggregateStore>());
builder.Services.AddSingleton<ContextInsightsBatchValidator>();
builder.Services.AddSingleton<TableContextInsightStore>();
builder.Services.AddSingleton<IContextInsightStore>(sp => sp.GetRequiredService<TableContextInsightStore>());
builder.Services.AddSingleton<TableSyncStatusStore>();
builder.Services.AddSingleton<ISyncStatusStore>(sp => sp.GetRequiredService<TableSyncStatusStore>());

// Phase 8: aggregate-backed analytics for the four org-level pages, with optional legacy
// (raw Log Analytics) source / fallback. The legacy path requires a configured workspace id;
// the aggregate path is standalone and must work even when Log Analytics is unconfigured.
builder.Services.Configure<AnalyticsOptions>(builder.Configuration.GetSection(AnalyticsOptions.SectionName));
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<AggregateAnalyticsService>();

var analyticsOptions = builder.Configuration.GetSection(AnalyticsOptions.SectionName).Get<AnalyticsOptions>() ?? new AnalyticsOptions();
var logAnalyticsWorkspaceConfigured = !string.IsNullOrEmpty(builder.Configuration[$"{LogAnalyticsOptions.SectionName}:WorkspaceId"]);

if (analyticsOptions.Source == AnalyticsSource.Legacy && logAnalyticsWorkspaceConfigured)
{
    builder.Services.AddSingleton<IAnalyticsService>(sp =>
        new LegacyAnalyticsService(sp.GetRequiredService<LogAnalyticsService>()));
}
else if (analyticsOptions.FallbackToLegacyWhenEmpty && logAnalyticsWorkspaceConfigured)
{
    builder.Services.AddSingleton<IAnalyticsService>(sp =>
        new FallbackAnalyticsService(
            sp.GetRequiredService<AggregateAnalyticsService>(),
            new LegacyAnalyticsService(sp.GetRequiredService<LogAnalyticsService>())));
}
else
{
    // Default: aggregate-only. Also the only safe option when no Log Analytics workspace is wired.
    builder.Services.AddSingleton<IAnalyticsService>(sp => sp.GetRequiredService<AggregateAnalyticsService>());
}

// Context-engineering hotspots (Context Hotspots page): ranks customization files from the
// privacy-scoped context-insights store. Always aggregate-backed; no legacy equivalent.
builder.Services.AddSingleton<IContextHotspotAnalyticsService, ContextHotspotAnalyticsService>();

var app = builder.Build();

// Make the silent legacy->aggregate downgrade observable: if an operator flips Source=Legacy for
// rollback but no Log Analytics workspace is configured, the aggregate path is served instead.
if (analyticsOptions.Source == AnalyticsSource.Legacy && !logAnalyticsWorkspaceConfigured)
{
    app.Logger.LogWarning(
        "Analytics:Source is 'Legacy' but no LogAnalytics:WorkspaceId is configured; serving the aggregate analytics path instead.");
}

// Ensure Table Storage tables exist
var workflowService = app.Services.GetRequiredService<WorkflowManagementService>();
await workflowService.EnsureTablesExistAsync();

var dashboardService = app.Services.GetRequiredService<DashboardService>();
await dashboardService.EnsureTablesExistAsync();

var learningService = app.Services.GetRequiredService<LearningService>();
await learningService.EnsureContainerExistsAsync();
await learningService.BackfillEmbeddingsAsync();

// Ensure the ingestion tables exist. Guarded so a missing/unavailable storage account does not
// crash startup of the dashboard.
try
{
    await app.Services.GetRequiredService<TableAggregateStore>().EnsureTablesExistAsync();
    await app.Services.GetRequiredService<TableContextInsightStore>().EnsureTablesExistAsync();
    await app.Services.GetRequiredService<TableSyncStatusStore>().EnsureTablesExistAsync();

    if (app.Services.GetService<TableApiKeyStore>() is { } tableApiKeyStore)
    {
        await tableApiKeyStore.EnsureTablesExistAsync();
    }
}
catch (Exception ex)
{
    app.Logger.LogWarning(ex, "Could not ensure ingestion tables exist; ingestion storage may be unavailable.");
}

if (!app.Environment.IsDevelopment())
{
    app.UseHsts();
}

app.UseHttpsRedirection();
app.UseStaticFiles();
app.UseAntiforgery();

app.MapRazorComponents<AgentObservability.Dashboard.App>()
    .AddInteractiveServerRenderMode();

app.MapIngestionApi();

app.Run();

// Exposed so a test host (WebApplicationFactory) can reference the entry-point assembly.
public partial class Program;