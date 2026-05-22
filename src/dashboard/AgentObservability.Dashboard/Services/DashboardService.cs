using System.Text.Json;
using AgentObservability.Dashboard.Models;
using Azure.Data.Tables;

namespace AgentObservability.Dashboard.Services;

public sealed class DashboardService
{
    private readonly TableClient _foldersTable;
    private readonly TableClient _dashboardsTable;
    private readonly TableClient _widgetsTable;
    private readonly ILogger<DashboardService> _logger;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    public DashboardService(TableServiceClient tableServiceClient, ILogger<DashboardService> logger)
    {
        _foldersTable = tableServiceClient.GetTableClient("DashboardFolders");
        _dashboardsTable = tableServiceClient.GetTableClient("Dashboards");
        _widgetsTable = tableServiceClient.GetTableClient("DashboardWidgets");
        _logger = logger;
    }

    public async Task EnsureTablesExistAsync()
    {
        await _foldersTable.CreateIfNotExistsAsync();
        await _dashboardsTable.CreateIfNotExistsAsync();
        await _widgetsTable.CreateIfNotExistsAsync();
    }

    // ─── Folders ────────────────────────────────────────────────────────────────

    public async Task<List<DashboardFolder>> GetFoldersAsync()
    {
        var folders = new List<DashboardFolder>();

        await foreach (var entity in _foldersTable.QueryAsync<TableEntity>(filter: "PartitionKey eq 'folder'"))
        {
            folders.Add(new DashboardFolder
            {
                Id = entity.RowKey!,
                ParentFolderId = entity.GetString("ParentFolderId"),
                Name = entity.GetString("Name") ?? string.Empty,
                SortOrder = entity.GetInt32("SortOrder") ?? 0
            });
        }

        return folders;
    }

    public async Task CreateFolderAsync(DashboardFolder folder)
    {
        var entity = new TableEntity("folder", folder.Id)
        {
            { "Name", folder.Name },
            { "ParentFolderId", folder.ParentFolderId },
            { "SortOrder", folder.SortOrder }
        };

        await _foldersTable.UpsertEntityAsync(entity);
        _logger.LogInformation("Created folder {Name} ({Id})", folder.Name, folder.Id);
    }

    public async Task RenameFolderAsync(string folderId, string newName)
    {
        var response = await _foldersTable.GetEntityAsync<TableEntity>("folder", folderId);
        var entity = response.Value;
        entity["Name"] = newName;
        await _foldersTable.UpsertEntityAsync(entity);
        _logger.LogInformation("Renamed folder {Id} to {Name}", folderId, newName);
    }

    public async Task MoveFolderAsync(string folderId, string? newParentId)
    {
        var response = await _foldersTable.GetEntityAsync<TableEntity>("folder", folderId);
        var entity = response.Value;
        entity["ParentFolderId"] = newParentId;
        await _foldersTable.UpsertEntityAsync(entity);
        _logger.LogInformation("Moved folder {Id} to parent {ParentId}", folderId, newParentId ?? "root");
    }

    public async Task DeleteFolderAsync(string folderId)
    {
        // Get all folders to find descendants
        var allFolders = await GetFoldersAsync();
        var idsToDelete = new List<string> { folderId };
        CollectDescendantFolderIds(folderId, allFolders, idsToDelete);

        // Delete all descendant folders and their dashboards
        foreach (var id in idsToDelete)
        {
            // Delete dashboards in this folder
            var dashboards = await GetDashboardsAsync(id);
            foreach (var dashboard in dashboards)
            {
                await DeleteDashboardAsync(dashboard.Id);
            }

            await _foldersTable.DeleteEntityAsync("folder", id);
        }

        _logger.LogInformation("Deleted folder {Id} and {Count} descendants", folderId, idsToDelete.Count - 1);
    }

    private static void CollectDescendantFolderIds(string parentId, List<DashboardFolder> allFolders, List<string> result)
    {
        foreach (var child in allFolders.Where(f => f.ParentFolderId == parentId))
        {
            result.Add(child.Id);
            CollectDescendantFolderIds(child.Id, allFolders, result);
        }
    }

    // ─── Dashboards ─────────────────────────────────────────────────────────────

    public async Task<List<CustomDashboard>> GetDashboardsAsync(string? folderId = null)
    {
        var dashboards = new List<CustomDashboard>();
        string filter = "PartitionKey eq 'dashboard'";

        await foreach (var entity in _dashboardsTable.QueryAsync<TableEntity>(filter: filter))
        {
            var dashboard = new CustomDashboard
            {
                Id = entity.RowKey!,
                FolderId = entity.GetString("FolderId"),
                Name = entity.GetString("Name") ?? string.Empty,
                Description = entity.GetString("Description") ?? string.Empty,
                GridColumns = entity.GetInt32("GridColumns") ?? 12,
                Filters = DeserializeFilters(entity.GetString("FiltersJson")),
                CreatedAt = entity.GetDateTimeOffset("CreatedAt") ?? DateTimeOffset.UtcNow,
                UpdatedAt = entity.GetDateTimeOffset("UpdatedAt") ?? DateTimeOffset.UtcNow
            };

            if (folderId is null || dashboard.FolderId == folderId)
            {
                dashboards.Add(dashboard);
            }
        }

        return dashboards;
    }

    public async Task<CustomDashboard?> GetDashboardAsync(string dashboardId)
    {
        try
        {
            var response = await _dashboardsTable.GetEntityAsync<TableEntity>("dashboard", dashboardId);
            var entity = response.Value;
            return new CustomDashboard
            {
                Id = entity.RowKey!,
                FolderId = entity.GetString("FolderId"),
                Name = entity.GetString("Name") ?? string.Empty,
                Description = entity.GetString("Description") ?? string.Empty,
                GridColumns = entity.GetInt32("GridColumns") ?? 12,
                Filters = DeserializeFilters(entity.GetString("FiltersJson")),
                CreatedAt = entity.GetDateTimeOffset("CreatedAt") ?? DateTimeOffset.UtcNow,
                UpdatedAt = entity.GetDateTimeOffset("UpdatedAt") ?? DateTimeOffset.UtcNow
            };
        }
        catch (Azure.RequestFailedException ex) when (ex.Status == 404)
        {
            return null;
        }
    }

    public async Task CreateDashboardAsync(CustomDashboard dashboard)
    {
        var entity = new TableEntity("dashboard", dashboard.Id)
        {
            { "FolderId", dashboard.FolderId },
            { "Name", dashboard.Name },
            { "Description", dashboard.Description },
            { "GridColumns", dashboard.GridColumns },
            { "FiltersJson", JsonSerializer.Serialize(dashboard.Filters, JsonOptions) },
            { "CreatedAt", dashboard.CreatedAt },
            { "UpdatedAt", dashboard.UpdatedAt }
        };

        await _dashboardsTable.UpsertEntityAsync(entity);
        _logger.LogInformation("Created dashboard {Name} ({Id})", dashboard.Name, dashboard.Id);
    }

    public async Task UpdateDashboardAsync(CustomDashboard dashboard)
    {
        dashboard.UpdatedAt = DateTimeOffset.UtcNow;
        var entity = new TableEntity("dashboard", dashboard.Id)
        {
            { "FolderId", dashboard.FolderId },
            { "Name", dashboard.Name },
            { "Description", dashboard.Description },
            { "GridColumns", dashboard.GridColumns },
            { "FiltersJson", JsonSerializer.Serialize(dashboard.Filters, JsonOptions) },
            { "CreatedAt", dashboard.CreatedAt },
            { "UpdatedAt", dashboard.UpdatedAt }
        };

        await _dashboardsTable.UpsertEntityAsync(entity);
        _logger.LogInformation("Updated dashboard {Name} ({Id})", dashboard.Name, dashboard.Id);
    }

    public async Task DeleteDashboardAsync(string dashboardId)
    {
        // Delete all widgets in this dashboard
        await foreach (var entity in _widgetsTable.QueryAsync<TableEntity>(filter: $"PartitionKey eq '{dashboardId}'"))
        {
            await _widgetsTable.DeleteEntityAsync(entity.PartitionKey, entity.RowKey!);
        }

        await _dashboardsTable.DeleteEntityAsync("dashboard", dashboardId);
        _logger.LogInformation("Deleted dashboard {Id} and its widgets", dashboardId);
    }

    // ─── Widgets ────────────────────────────────────────────────────────────────

    public async Task<List<DashboardWidget>> GetWidgetsAsync(string dashboardId)
    {
        var widgets = new List<DashboardWidget>();

        await foreach (var entity in _widgetsTable.QueryAsync<TableEntity>(filter: $"PartitionKey eq '{dashboardId}'"))
        {
            widgets.Add(new DashboardWidget
            {
                Id = entity.RowKey!,
                DashboardId = dashboardId,
                Title = entity.GetString("Title") ?? string.Empty,
                WidgetType = Enum.TryParse<WidgetType>(entity.GetString("WidgetType"), out var wt) ? wt : WidgetType.MetricCard,
                KqlQuery = entity.GetString("KqlQuery") ?? string.Empty,
                GridColumn = entity.GetInt32("GridColumn") ?? 1,
                GridRow = entity.GetInt32("GridRow") ?? 1,
                ColumnSpan = entity.GetInt32("ColumnSpan") ?? 3,
                RowSpan = entity.GetInt32("RowSpan") ?? 1,
                Configuration = entity.GetString("Configuration")
            });
        }

        return widgets.OrderBy(w => w.GridRow).ThenBy(w => w.GridColumn).ToList();
    }

    public async Task AddWidgetAsync(DashboardWidget widget)
    {
        var entity = new TableEntity(widget.DashboardId, widget.Id)
        {
            { "Title", widget.Title },
            { "WidgetType", widget.WidgetType.ToString() },
            { "KqlQuery", widget.KqlQuery },
            { "GridColumn", widget.GridColumn },
            { "GridRow", widget.GridRow },
            { "ColumnSpan", widget.ColumnSpan },
            { "RowSpan", widget.RowSpan },
            { "Configuration", widget.Configuration }
        };

        await _widgetsTable.UpsertEntityAsync(entity);
        _logger.LogInformation("Added widget {Title} ({Id}) to dashboard {DashboardId}", widget.Title, widget.Id, widget.DashboardId);
    }

    public async Task UpdateWidgetAsync(DashboardWidget widget)
    {
        var entity = new TableEntity(widget.DashboardId, widget.Id)
        {
            { "Title", widget.Title },
            { "WidgetType", widget.WidgetType.ToString() },
            { "KqlQuery", widget.KqlQuery },
            { "GridColumn", widget.GridColumn },
            { "GridRow", widget.GridRow },
            { "ColumnSpan", widget.ColumnSpan },
            { "RowSpan", widget.RowSpan },
            { "Configuration", widget.Configuration }
        };

        await _widgetsTable.UpsertEntityAsync(entity);
        _logger.LogInformation("Updated widget {Title} ({Id})", widget.Title, widget.Id);
    }

    public async Task RemoveWidgetAsync(string dashboardId, string widgetId)
    {
        await _widgetsTable.DeleteEntityAsync(dashboardId, widgetId);
        _logger.LogInformation("Removed widget {Id} from dashboard {DashboardId}", widgetId, dashboardId);
    }

    // ─── Helpers ────────────────────────────────────────────────────────────────

    private static List<DashboardFilter> DeserializeFilters(string? json)
    {
        if (string.IsNullOrEmpty(json))
            return [];

        return JsonSerializer.Deserialize<List<DashboardFilter>>(json, JsonOptions) ?? [];
    }
}
