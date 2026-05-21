using System.Text.Json;
using AgentObservability.Dashboard.Models;
using Azure.Data.Tables;

namespace AgentObservability.Dashboard.Services;

public sealed class WorkflowManagementService
{
    private readonly TableClient _repositoriesTable;
    private readonly TableClient _workflowsTable;
    private readonly ILogger<WorkflowManagementService> _logger;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    public WorkflowManagementService(TableServiceClient tableServiceClient, ILogger<WorkflowManagementService> logger)
    {
        _repositoriesTable = tableServiceClient.GetTableClient("Repositories");
        _workflowsTable = tableServiceClient.GetTableClient("Workflows");
        _logger = logger;
    }

    public async Task EnsureTablesExistAsync()
    {
        await _repositoriesTable.CreateIfNotExistsAsync();
        await _workflowsTable.CreateIfNotExistsAsync();
    }

    // ─── Repositories ───────────────────────────────────────────────────────────

    public async Task<List<ManagedRepository>> GetRepositoriesAsync()
    {
        var repositories = new List<ManagedRepository>();

        await foreach (var entity in _repositoriesTable.QueryAsync<TableEntity>(filter: $"PartitionKey eq 'repo'"))
        {
            repositories.Add(new ManagedRepository
            {
                Id = entity.RowKey!,
                Name = entity.GetString("Name") ?? string.Empty,
                RepoUrl = entity.GetString("RepoUrl") ?? string.Empty
            });
        }

        return repositories;
    }

    public async Task AddRepositoryAsync(ManagedRepository repository)
    {
        var entity = new TableEntity("repo", repository.Id)
        {
            { "Name", repository.Name },
            { "RepoUrl", repository.RepoUrl }
        };

        await _repositoriesTable.UpsertEntityAsync(entity);
        _logger.LogInformation("Added repository {Name} ({Id})", repository.Name, repository.Id);
    }

    public async Task UpdateRepositoryAsync(ManagedRepository repository)
    {
        var entity = new TableEntity("repo", repository.Id)
        {
            { "Name", repository.Name },
            { "RepoUrl", repository.RepoUrl }
        };

        await _repositoriesTable.UpsertEntityAsync(entity);
        _logger.LogInformation("Updated repository {Name} ({Id})", repository.Name, repository.Id);
    }

    public async Task DeleteRepositoryAsync(string id)
    {
        await _repositoriesTable.DeleteEntityAsync("repo", id);

        // Cascade delete workflows for this repository
        await foreach (var entity in _workflowsTable.QueryAsync<TableEntity>(filter: $"PartitionKey eq '{id}'"))
        {
            await _workflowsTable.DeleteEntityAsync(entity.PartitionKey, entity.RowKey!);
        }

        _logger.LogInformation("Deleted repository {Id} and its workflows", id);
    }

    // ─── Workflows ──────────────────────────────────────────────────────────────

    public async Task<List<ManagedWorkflow>> GetWorkflowsAsync(string repositoryId)
    {
        var workflows = new List<ManagedWorkflow>();

        await foreach (var entity in _workflowsTable.QueryAsync<TableEntity>(filter: $"PartitionKey eq '{repositoryId}'"))
        {
            var workflow = new ManagedWorkflow
            {
                Id = entity.RowKey!,
                RepositoryId = repositoryId,
                Name = entity.GetString("Name") ?? string.Empty,
                TriggerConditions = DeserializeTriggerConditions(entity.GetString("TriggerJson")),
                Steps = DeserializeSteps(entity.GetString("StepsJson"))
            };

            workflows.Add(workflow);
        }

        return workflows;
    }

    public async Task AddWorkflowAsync(ManagedWorkflow workflow)
    {
        var entity = new TableEntity(workflow.RepositoryId, workflow.Id)
        {
            { "Name", workflow.Name },
            { "TriggerJson", JsonSerializer.Serialize(workflow.TriggerConditions, JsonOptions) },
            { "StepsJson", JsonSerializer.Serialize(workflow.Steps, JsonOptions) }
        };

        await _workflowsTable.UpsertEntityAsync(entity);
        _logger.LogInformation("Added workflow {Name} ({Id}) to repository {RepoId}", workflow.Name, workflow.Id, workflow.RepositoryId);
    }

    public async Task UpdateWorkflowAsync(ManagedWorkflow workflow)
    {
        var entity = new TableEntity(workflow.RepositoryId, workflow.Id)
        {
            { "Name", workflow.Name },
            { "TriggerJson", JsonSerializer.Serialize(workflow.TriggerConditions, JsonOptions) },
            { "StepsJson", JsonSerializer.Serialize(workflow.Steps, JsonOptions) }
        };

        await _workflowsTable.UpsertEntityAsync(entity);
        _logger.LogInformation("Updated workflow {Name} ({Id})", workflow.Name, workflow.Id);
    }

    public async Task DeleteWorkflowAsync(string repositoryId, string workflowId)
    {
        await _workflowsTable.DeleteEntityAsync(repositoryId, workflowId);
        _logger.LogInformation("Deleted workflow {Id} from repository {RepoId}", workflowId, repositoryId);
    }

    // ─── Helpers ────────────────────────────────────────────────────────────────

    private static List<TriggerCondition> DeserializeTriggerConditions(string? json)
    {
        if (string.IsNullOrEmpty(json))
        {
            return [new TriggerCondition()];
        }

        // Support legacy single-object format
        if (json.TrimStart().StartsWith('{'))
        {
            var single = JsonSerializer.Deserialize<TriggerCondition>(json, JsonOptions);
            return single is not null ? [single] : [new TriggerCondition()];
        }

        return JsonSerializer.Deserialize<List<TriggerCondition>>(json, JsonOptions) ?? [new TriggerCondition()];
    }

    private static List<WorkflowStep> DeserializeSteps(string? json)
    {
        if (string.IsNullOrEmpty(json))
        {
            return [];
        }

        return JsonSerializer.Deserialize<List<WorkflowStep>>(json, JsonOptions) ?? [];
    }
}
