namespace AgentObservability.Dashboard.Models;

public enum WidgetType
{
    MetricCard,
    LineChart,
    BarChart,
    PieChart,
    Table
}

public sealed class DashboardWidget
{
    public string Id { get; set; } = Guid.NewGuid().ToString();
    public string DashboardId { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public WidgetType WidgetType { get; set; } = WidgetType.MetricCard;
    public string KqlQuery { get; set; } = string.Empty;
    public int GridColumn { get; set; } = 1;
    public int GridRow { get; set; } = 1;
    public int ColumnSpan { get; set; } = 3;
    public int RowSpan { get; set; } = 1;
    public string? Configuration { get; set; }
}
