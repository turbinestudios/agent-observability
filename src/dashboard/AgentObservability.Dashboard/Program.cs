using AgentObservability.Dashboard.Components;
using AgentObservability.Dashboard.Services;
using AgentObservability.Dashboard;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();

builder.Services.Configure<LogAnalyticsOptions>(builder.Configuration.GetSection(LogAnalyticsOptions.SectionName));
builder.Services.AddSingleton<LogAnalyticsService>();

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