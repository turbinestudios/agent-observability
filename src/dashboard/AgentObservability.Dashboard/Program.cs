using AgentObservability.Dashboard.Components;
using AgentObservability.Dashboard.Models;
using AgentObservability.Dashboard.Services;
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

var app = builder.Build();

// Ensure Table Storage tables exist
var workflowService = app.Services.GetRequiredService<WorkflowManagementService>();
await workflowService.EnsureTablesExistAsync();

var dashboardService = app.Services.GetRequiredService<DashboardService>();
await dashboardService.EnsureTablesExistAsync();

var learningService = app.Services.GetRequiredService<LearningService>();
await learningService.EnsureContainerExistsAsync();
await learningService.BackfillEmbeddingsAsync();

if (!app.Environment.IsDevelopment())
{
    app.UseHsts();
}

app.UseHttpsRedirection();
app.UseStaticFiles();
app.UseAntiforgery();

app.MapRazorComponents<AgentObservability.Dashboard.App>()
    .AddInteractiveServerRenderMode();

app.Run();