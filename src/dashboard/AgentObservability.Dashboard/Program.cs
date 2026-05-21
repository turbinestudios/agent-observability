using AgentObservability.Dashboard.Components;
using AgentObservability.Dashboard.Models;
using AgentObservability.Dashboard.Services;
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

var app = builder.Build();

// Ensure Table Storage tables exist
var workflowService = app.Services.GetRequiredService<WorkflowManagementService>();
await workflowService.EnsureTablesExistAsync();

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