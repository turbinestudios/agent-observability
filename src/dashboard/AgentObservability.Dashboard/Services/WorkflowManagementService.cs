using System.Text.Json;
using AgentObservability.Dashboard.Models;
using Azure.Data.Tables;

namespace AgentObservability.Dashboard.Services;

public sealed class WorkflowManagementService
{
    private readonly TableClient _foldersTable;
    private readonly TableClient _workflowsTable;
    private readonly ILogger<WorkflowManagementService> _logger;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    public WorkflowManagementService(TableServiceClient tableServiceClient, ILogger<WorkflowManagementService> logger)
    {
        _foldersTable = tableServiceClient.GetTableClient("WorkflowFolders");
        _workflowsTable = tableServiceClient.GetTableClient("Workflows");
        _logger = logger;
    }

    public async Task EnsureTablesExistAsync()
    {
        await _foldersTable.CreateIfNotExistsAsync();
        await _workflowsTable.CreateIfNotExistsAsync();
    }

    // ─── Folders ────────────────────────────────────────────────────────────────

    public async Task<List<WorkflowFolder>> GetFoldersAsync()
    {
        var folders = new List<WorkflowFolder>();

        await foreach (var entity in _foldersTable.QueryAsync<TableEntity>(filter: "PartitionKey eq 'folder'"))
        {
            folders.Add(new WorkflowFolder
            {
                Id = entity.RowKey!,
                ParentFolderId = entity.GetString("ParentFolderId"),
                Name = entity.GetString("Name") ?? string.Empty,
                SortOrder = entity.GetInt32("SortOrder") ?? 0
            });
        }

        return folders;
    }

    public async Task CreateFolderAsync(WorkflowFolder folder)
    {
        var entity = new TableEntity("folder", folder.Id)
        {
            { "Name", folder.Name },
            { "ParentFolderId", folder.ParentFolderId },
            { "SortOrder", folder.SortOrder }
        };

        await _foldersTable.UpsertEntityAsync(entity);
        _logger.LogInformation("Created workflow folder {Name} ({Id})", folder.Name, folder.Id);
    }

    public async Task RenameFolderAsync(string folderId, string newName)
    {
        var entity = new TableEntity("folder", folderId)
        {
            { "Name", newName }
        };

        await _foldersTable.UpsertEntityAsync(entity, TableUpdateMode.Merge);
        _logger.LogInformation("Renamed workflow folder {Id} to {Name}", folderId, newName);
    }

    public async Task DeleteFolderAsync(string folderId)
    {
        // Collect all descendant folder IDs
        var allFolders = await GetFoldersAsync();
        var folderIds = CollectDescendantFolderIds(folderId, allFolders);
        folderIds.Add(folderId);

        // Delete workflows in all affected folders
        foreach (var id in folderIds)
        {
            await foreach (var entity in _workflowsTable.QueryAsync<TableEntity>(filter: "PartitionKey eq 'workflow'"))
            {
                if (entity.GetString("FolderId") == id)
                {
                    await _workflowsTable.DeleteEntityAsync(entity.PartitionKey, entity.RowKey!);
                }
            }
            await _foldersTable.DeleteEntityAsync("folder", id);
        }

        _logger.LogInformation("Deleted workflow folder {Id} and descendants", folderId);
    }

    private static List<string> CollectDescendantFolderIds(string parentId, List<WorkflowFolder> allFolders)
    {
        var result = new List<string>();
        var children = allFolders.Where(f => f.ParentFolderId == parentId);
        foreach (var child in children)
        {
            result.Add(child.Id);
            result.AddRange(CollectDescendantFolderIds(child.Id, allFolders));
        }
        return result;
    }

    // ─── Workflows ──────────────────────────────────────────────────────────────

    public async Task<List<ManagedWorkflow>> GetWorkflowsAsync(string? folderId = null)
    {
        var workflows = new List<ManagedWorkflow>();

        await foreach (var entity in _workflowsTable.QueryAsync<TableEntity>(filter: "PartitionKey eq 'workflow'"))
        {
            var workflow = new ManagedWorkflow
            {
                Id = entity.RowKey!,
                FolderId = entity.GetString("FolderId"),
                Name = entity.GetString("Name") ?? string.Empty,
                TriggerKqlQuery = entity.GetString("TriggerKqlQuery") ?? string.Empty,
                Steps = DeserializeSteps(entity.GetString("StepsJson"))
            };

            if (folderId is null || workflow.FolderId == folderId)
            {
                workflows.Add(workflow);
            }
        }

        return workflows;
    }

    public async Task<ManagedWorkflow?> GetWorkflowAsync(string workflowId)
    {
        try
        {
            var entity = await _workflowsTable.GetEntityAsync<TableEntity>("workflow", workflowId);
            return new ManagedWorkflow
            {
                Id = entity.Value.RowKey!,
                FolderId = entity.Value.GetString("FolderId"),
                Name = entity.Value.GetString("Name") ?? string.Empty,
                TriggerKqlQuery = entity.Value.GetString("TriggerKqlQuery") ?? string.Empty,
                Steps = DeserializeSteps(entity.Value.GetString("StepsJson"))
            };
        }
        catch (Azure.RequestFailedException ex) when (ex.Status == 404)
        {
            return null;
        }
    }

    public async Task CreateWorkflowAsync(ManagedWorkflow workflow)
    {
        var entity = new TableEntity("workflow", workflow.Id)
        {
            { "FolderId", workflow.FolderId },
            { "Name", workflow.Name },
            { "TriggerKqlQuery", workflow.TriggerKqlQuery },
            { "StepsJson", JsonSerializer.Serialize(workflow.Steps, JsonOptions) }
        };

        await _workflowsTable.UpsertEntityAsync(entity);
        _logger.LogInformation("Created workflow {Name} ({Id})", workflow.Name, workflow.Id);
    }

    public async Task UpdateWorkflowAsync(ManagedWorkflow workflow)
    {
        var entity = new TableEntity("workflow", workflow.Id)
        {
            { "FolderId", workflow.FolderId },
            { "Name", workflow.Name },
            { "TriggerKqlQuery", workflow.TriggerKqlQuery },
            { "StepsJson", JsonSerializer.Serialize(workflow.Steps, JsonOptions) }
        };

        await _workflowsTable.UpsertEntityAsync(entity);
        _logger.LogInformation("Updated workflow {Name} ({Id})", workflow.Name, workflow.Id);
    }

    public async Task DeleteWorkflowAsync(string workflowId)
    {
        await _workflowsTable.DeleteEntityAsync("workflow", workflowId);
        _logger.LogInformation("Deleted workflow {Id}", workflowId);
    }

    public async Task MoveWorkflowAsync(string workflowId, string? newFolderId)
    {
        var workflow = await GetWorkflowAsync(workflowId);
        if (workflow is not null)
        {
            workflow.FolderId = newFolderId;
            await UpdateWorkflowAsync(workflow);
            _logger.LogInformation("Moved workflow {Id} to folder {FolderId}", workflowId, newFolderId ?? "(root)");
        }
    }

    // ─── Helpers ────────────────────────────────────────────────────────────────

    private static List<WorkflowStep> DeserializeSteps(string? json)
    {
        if (string.IsNullOrEmpty(json))
        {
            return [];
        }

        return JsonSerializer.Deserialize<List<WorkflowStep>>(json, JsonOptions) ?? [];
    }
}
