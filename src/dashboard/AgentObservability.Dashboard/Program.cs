using AgentObservability.Dashboard.Components;
using AgentObservability.Dashboard.Models;
using AgentObservability.Dashboard.Services;
using AgentObservability.Dashboard;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();

builder.Services.AddRadzenComponents();

builder.Services.Configure<LogAnalyticsOptions>(builder.Configuration.GetSection(LogAnalyticsOptions.SectionName));
builder.Services.AddSingleton<LogAnalyticsService>();

// Phase 5: Alert Engine & Workflow Deviation Detection
builder.Services.Configure<AlertEngineOptions>(builder.Configuration.GetSection(AlertEngineOptions.SectionName));
builder.Services.AddSingleton<WorkflowDeviationDetector>();
builder.Services.AddHttpClient("AlertEngine");
builder.Services.AddHostedService<AlertEngine>();

var app = builder.Build();

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