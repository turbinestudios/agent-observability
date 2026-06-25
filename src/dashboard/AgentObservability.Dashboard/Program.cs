using AgentObservability.Dashboard.Components;
using AgentObservability.Dashboard.Models;
using AgentObservability.Dashboard.Services;
using AgentObservability.Dashboard.Services.Analytics;
using AgentObservability.Dashboard.Services.Ingestion;
using AgentObservability.Dashboard;
using Azure.Data.Tables;
using Azure.Identity;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();

builder.Services.AddScoped<Radzen.TooltipService>();
builder.Services.AddScoped<Radzen.DialogService>();
builder.Services.AddScoped<Radzen.NotificationService>();
builder.Services.AddScoped<Radzen.ContextMenuService>();

// Azure Table Storage client backing the aggregate, context-insights, sync-status and API-key stores.
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

// Cloud Ingestion API.
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

// Aggregate-backed analytics for the org-level pages (Overview, Repository, Developer Activity,
// LLM Analytics). Backed solely by the privacy-scoped aggregate store in Table Storage.
builder.Services.Configure<AnalyticsOptions>(builder.Configuration.GetSection(AnalyticsOptions.SectionName));
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<AggregateAnalyticsService>();
builder.Services.AddSingleton<IAnalyticsService>(sp => sp.GetRequiredService<AggregateAnalyticsService>());

// Context-engineering hotspots (Context Hotspots page): ranks customization files from the
// privacy-scoped context-insights store.
builder.Services.AddSingleton<IContextHotspotAnalyticsService, ContextHotspotAnalyticsService>();

var app = builder.Build();

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