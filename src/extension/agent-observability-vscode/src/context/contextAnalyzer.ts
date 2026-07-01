/**
 * Context analysis orchestrator — combines discovery parsing, tool-call detection,
 * reference resolution, and size estimation into a complete per-agent and
 * aggregated context analysis for a session.
 *
 * LOCAL-ONLY: all analysis is performed on-machine. The resulting
 * {@link SessionContextAnalysis} is rendered in the local webview only.
 */

import type { TelemetryService } from '../telemetry/telemetryService';
import { classifyAgentSpan } from '../telemetry/database';
import type {
  AgentContextAnalysis,
  ContextFileEntry,
  ExpectedMissingFile,
  SessionContextAnalysis,
} from './models';
import { parseDiscoveryEvents, type DiscoveryEventRow } from './discoveryParser';
import { parseToolReads, type ToolReadRow } from './toolCallDetector';
import { resolveReferences } from './referenceResolver';
import { estimateContextSizes, findOversizedFiles } from './sizeEstimator';

/**
 * Configuration for files/sources accepted as missing (excluded from
 * the "expected but missing" analysis). Read from workspace settings.
 */
export interface AcceptedMissingConfig {
  /** File names that are accepted as missing. */
  files: readonly string[];
  /** Source file names whose outgoing references should be suppressed. */
  sources: readonly string[];
}

/**
 * Run the full context analysis pipeline for a session.
 *
 * @param sessionKey - The session to analyze
 * @param telemetry - Telemetry service for database access
 * @param acceptedMissing - Optional exclusion config to suppress expected-missing entries
 * @param subagentNames - Optional pre-resolved map from session id to friendly agent name
 * @param subagentNamesList - Optional ordered list of known subagent friendly names (from Overview tab)
 * @returns Complete context analysis, or undefined if no data available
 */
export function analyzeContext(
  sessionKey: string,
  telemetry: TelemetryService,
  acceptedMissing?: AcceptedMissingConfig,
  subagentNames?: Map<string, string>,
  subagentNamesList?: readonly string[],
): SessionContextAnalysis | undefined {
  // 1. Fetch raw data from telemetry
  const discoveryResult = telemetry.getContextDiscoveryEvents(sessionKey);
  const toolReadsResult = telemetry.getContextToolReads(sessionKey);
  const systemInstrResult = telemetry.getSystemInstructionsBySpan(sessionKey);

  if (!discoveryResult.ok && !toolReadsResult.ok && !systemInstrResult.ok) {
    return undefined;
  }

  const discoveryEvents: DiscoveryEventRow[] = discoveryResult.ok ? discoveryResult.value : [];
  const toolReads = toolReadsResult.ok ? toolReadsResult.value : [];
  const systemInstrMap = systemInstrResult.ok ? systemInstrResult.value : new Map();

  // If no data at all, return undefined
  if (discoveryEvents.length === 0 && toolReads.length === 0 && systemInstrMap.size === 0) {
    return undefined;
  }

  // Resolve subagent names: use pre-resolved map if provided, else fetch from DB.
  let resolvedNames: Map<string, string>;
  if (subagentNames !== undefined && subagentNames.size > 0) {
    resolvedNames = subagentNames;
  } else {
    const subagentNamesResult = telemetry.getSubagentNames(sessionKey);
    resolvedNames = subagentNamesResult.ok ? subagentNamesResult.value : new Map();
  }

  // 2. Partition events by agent (main vs subagents)
  // Main agent: conversation_id === chat_session_id, or the root session
  // Subagents: conversation_id !== chat_session_id (spawned under a different id)
  const agentPartitions = partitionByAgent(discoveryEvents, toolReads, systemInstrMap, resolvedNames, subagentNamesList);

  // 3. Build per-agent analyses
  const agents: AgentContextAnalysis[] = [];
  for (const partition of agentPartitions) {
    const analysis = buildAgentAnalysis(partition, acceptedMissing);
    agents.push(analysis);
  }

  // 4. Build the "total" aggregate
  const total = buildTotalAnalysis(agents);

  return { total, agents };
}

/** Partition of data belonging to one agent conversation. */
interface AgentPartition {
  agentName: string;
  kind: 'main' | 'subagent';
  discoveryEvents: DiscoveryEventRow[];
  toolReads: Array<{ filePath: string; conversationId: string | null; chatSessionId: string | null; agentName: string | null; debugLabel: string | null }>;
  systemInstructionsText: string | undefined;
  inputTokens: number;
}

/**
 * Partition raw data by agent using the same classification rule as the
 * Overview tab: a span is a subagent turn when its `debug_log_label` starts
 * with `runSubagent-` or its `agent_name` starts with `tool/runSubagent`;
 * otherwise it's main. The friendly name is derived from those same fields,
 * so the Context Analysis tab matches the Overview tab 1:1.
 *
 * Discovery events and tool reads on non-chat spans (which lack the
 * classification attributes) fall back to a conversation-id lookup against
 * the chat-span classifications computed above.
 */
function partitionByAgent(
  discoveryEvents: DiscoveryEventRow[],
  toolReads: Array<{ filePath: string; conversationId: string | null; chatSessionId: string | null; agentName: string | null; debugLabel: string | null }>,
  systemInstrMap: Map<string, { value: string; conversationId: string | null; chatSessionId: string | null; inputTokens: number; agentName: string | null; debugLabel: string | null }>,
  subagentNames: Map<string, string>,
  subagentNamesList?: readonly string[],
): AgentPartition[] {
  // partitionKey: '__main__' for the main agent, friendly name for subagents.
  const partitions = new Map<string, AgentPartition>();

  // Build a fallback map from conversation_id → partition key, derived from
  // chat spans (system_instructions). For non-chat events (discovery, tool
  // reads) that lack agent_name/debug_label, we look up by conversation_id.
  const convToPartitionKey = new Map<string, string>();

  function partitionKeyFor(agentName: string | null, debugLabel: string | null): { key: string; friendlyName: string; kind: 'main' | 'subagent' } {
    const { kind, friendlyName } = classifyAgentSpan(agentName, debugLabel);
    return {
      key: kind === 'main' ? '__main__' : friendlyName,
      friendlyName: kind === 'main' ? 'Main Agent' : friendlyName,
      kind,
    };
  }

  function getOrCreatePartition(key: string, friendlyName: string, kind: 'main' | 'subagent'): AgentPartition {
    let p = partitions.get(key);
    if (!p) {
      p = {
        agentName: friendlyName,
        kind,
        discoveryEvents: [],
        toolReads: [],
        systemInstructionsText: undefined,
        inputTokens: 0,
      };
      partitions.set(key, p);
    }
    return p;
  }

  // 1. Process system instructions first — they carry the authoritative
  //    agent_name/debug_label and the inputTokens that drive the context bar.
  //    Also build convToPartitionKey for the fallback lookup below.
  for (const [, entry] of systemInstrMap) {
    const { key, friendlyName, kind } = partitionKeyFor(entry.agentName, entry.debugLabel);
    const partition = getOrCreatePartition(key, friendlyName, kind);
    // Use the LARGEST input_tokens span as the representative — captures the
    // most complete context window snapshot for this agent.
    if (entry.inputTokens > partition.inputTokens) {
      partition.systemInstructionsText = entry.value;
      partition.inputTokens = entry.inputTokens;
    }
    // Map this conversation id to its partition for fallback classification.
    if (entry.conversationId !== null && !convToPartitionKey.has(entry.conversationId)) {
      convToPartitionKey.set(entry.conversationId, key);
    }
    if (entry.chatSessionId !== null && !convToPartitionKey.has(entry.chatSessionId)) {
      // Only map chat_session_id when no conversation_id mapping exists yet —
      // chat_session_id is often shared across main and subagent spans, so we
      // don't want to overwrite a more specific mapping.
      if (!convToPartitionKey.has(entry.chatSessionId)) {
        convToPartitionKey.set(entry.chatSessionId, key);
      }
    }
  }

  // 2. Process discovery events — these are core_event spans that may or may
  //    not carry agent_name/debug_label. If present, classify directly;
  //    otherwise fall back to conv/chat-session-id lookup.
  for (const event of discoveryEvents) {
    let key: string;
    let friendlyName: string;
    let kind: 'main' | 'subagent';
    if (event.agentName !== null || event.debugLabel !== null) {
      const r = partitionKeyFor(event.agentName, event.debugLabel);
      key = r.key; friendlyName = r.friendlyName; kind = r.kind;
    } else {
      // Fallback: look up by conversation_id, then chat_session_id.
      const found = (event.conversationId !== null ? convToPartitionKey.get(event.conversationId) : undefined)
        ?? (event.chatSessionId !== null ? convToPartitionKey.get(event.chatSessionId) : undefined);
      if (found !== undefined) {
        key = found;
        const existing = partitions.get(found);
        friendlyName = existing?.agentName ?? 'Main Agent';
        kind = existing?.kind ?? 'main';
      } else {
        // No classification possible — default to main.
        key = '__main__';
        friendlyName = 'Main Agent';
        kind = 'main';
      }
    }
    const partition = getOrCreatePartition(key, friendlyName, kind);
    partition.discoveryEvents.push(event);
  }

  // 3. Process tool reads — same fallback pattern.
  for (const read of toolReads) {
    let key: string;
    let friendlyName: string;
    let kind: 'main' | 'subagent';
    if (read.agentName !== null || read.debugLabel !== null) {
      const r = partitionKeyFor(read.agentName, read.debugLabel);
      key = r.key; friendlyName = r.friendlyName; kind = r.kind;
    } else {
      const found = (read.conversationId !== null ? convToPartitionKey.get(read.conversationId) : undefined)
        ?? (read.chatSessionId !== null ? convToPartitionKey.get(read.chatSessionId) : undefined);
      if (found !== undefined) {
        key = found;
        const existing = partitions.get(found);
        friendlyName = existing?.agentName ?? 'Main Agent';
        kind = existing?.kind ?? 'main';
      } else {
        key = '__main__';
        friendlyName = 'Main Agent';
        kind = 'main';
      }
    }
    const partition = getOrCreatePartition(key, friendlyName, kind);
    partition.toolReads.push(read);
  }

  // 4. Ensure main partition exists.
  if (!partitions.has('__main__')) {
    partitions.set('__main__', {
      agentName: 'Main Agent',
      kind: 'main',
      discoveryEvents: [],
      toolReads: [],
      systemInstructionsText: undefined,
      inputTokens: 0,
    });
  }

  // 5. Post-process: if any subagent partition still has the generic name
  //    "Sub-agent" (no debug label was present), try to assign a name from
  //    the pre-resolved list or the DB-resolved map.
  const unnamedSubagents = [...partitions.entries()].filter(
    ([key, p]) => p.kind === 'subagent' && key === 'Sub-agent' && p.agentName === 'Sub-agent',
  );
  if (unnamedSubagents.length > 0) {
    const usedNames = new Set(
      [...partitions.values()]
        .filter((p) => p.kind === 'subagent' && p.agentName !== 'Sub-agent')
        .map((p) => p.agentName),
    );
    const sourceNames = (subagentNamesList && subagentNamesList.length > 0)
      ? subagentNamesList
      : [...new Set(subagentNames.values())];
    const availableNames = sourceNames.filter((n) => !usedNames.has(n));
    if (unnamedSubagents.length === 1 && availableNames.length === 1) {
      const [oldKey, p] = unnamedSubagents[0];
      p.agentName = availableNames[0];
      partitions.delete(oldKey);
      partitions.set(availableNames[0], p);
    }
  }

  // 6. Sort: main first, then subagents alphabetically.
  const result = [...partitions.values()];
  result.sort((a, b) => {
    if (a.kind === 'main' && b.kind !== 'main') return -1;
    if (a.kind !== 'main' && b.kind === 'main') return 1;
    return a.agentName.localeCompare(b.agentName);
  });

  return result;
}

/**
 * Source-agnostic per-agent context analysis inputs. Both the Copilot path
 * (discovery events + tool reads parsed from OTel span attributes) and the Claude
 * path (filesystem discovery + transcript tool reads) reduce their raw data to
 * this shape, so {@link buildAgentAnalysisFromParts} runs the identical reference/
 * size/oversized pipeline for either source.
 */
export interface AgentContextParts {
  /** Friendly name: "Main Agent" or the subagent name. */
  agentName: string;
  /** Whether this is the main thread or a spawned subagent. */
  kind: 'main' | 'subagent';
  /** Already-parsed discovery/customization file entries (applied/skipped). */
  discoveryFiles: ContextFileEntry[];
  /** Raw file-read rows to fold in as `read` entries (deduped, filtered upstream). */
  toolReadRows: readonly ToolReadRow[];
  /** Raw system-prompt text for per-file size attribution; `undefined` for Claude. */
  systemInstructionsText: string | undefined;
  /** Representative context-window token count (largest span/turn). */
  inputTokens: number;
}

/**
 * Build a single agent's context analysis from its partition of data (Copilot).
 * Thin wrapper that parses the Copilot discovery event strings, then delegates to
 * the shared {@link buildAgentAnalysisFromParts}.
 */
function buildAgentAnalysis(partition: AgentPartition, acceptedMissing?: AcceptedMissingConfig): AgentContextAnalysis {
  return buildAgentAnalysisFromParts(
    {
      agentName: partition.agentName,
      kind: partition.kind,
      discoveryFiles: parseDiscoveryEvents(partition.discoveryEvents),
      toolReadRows: partition.toolReads,
      systemInstructionsText: partition.systemInstructionsText,
      inputTokens: partition.inputTokens,
    },
    acceptedMissing,
  );
}

/**
 * Build a single agent's context analysis from source-agnostic {@link AgentContextParts}.
 * Runs the shared pipeline: fold tool reads into the loaded set, resolve
 * cross-references, detect expected-but-missing files, estimate per-file sizes, and
 * flag oversized files.
 */
export function buildAgentAnalysisFromParts(
  parts: AgentContextParts,
  acceptedMissing?: AcceptedMissingConfig,
): AgentContextAnalysis {
  const { discoveryFiles } = parts;

  // Detect additional files from tool reads (skip ones already from discovery)
  const knownNames = new Set(discoveryFiles.map((f) => f.name));
  const toolReadFiles = parseToolReads(parts.toolReadRows, knownNames);

  // Combine all loaded files
  const allFiles = [...discoveryFiles, ...toolReadFiles];

  // Resolve cross-references (only among applied/read files)
  const appliedFiles = allFiles.filter((f) => f.status !== 'skipped');
  const references = resolveReferences(appliedFiles, parts.systemInstructionsText);

  // Detect expected-but-missing files
  const loadedNames = new Set(allFiles.filter((f) => f.status !== 'skipped').map((f) => f.name));
  let expectedMissing = detectExpectedMissing(references, loadedNames);

  // Apply accepted-missing exclusions
  if (acceptedMissing) {
    expectedMissing = filterAcceptedMissing(expectedMissing, acceptedMissing);
  }

  // Estimate sizes
  const { entries, totalContextTokens, contextFileTokens, otherContextTokens } =
    estimateContextSizes(allFiles, parts.systemInstructionsText, parts.inputTokens);

  // Find oversized files
  const oversizedFiles = findOversizedFiles(entries);

  return {
    agentName: parts.agentName,
    kind: parts.kind,
    loadedFiles: entries,
    expectedMissing,
    totalContextTokens,
    contextFileTokens,
    otherContextTokens,
    oversizedFiles,
  };
}

/**
 * Detect files that are referenced by loaded files but not themselves loaded.
 */
function detectExpectedMissing(
  references: readonly import('./models').ContextFileReference[],
  loadedNames: ReadonlySet<string>,
): ExpectedMissingFile[] {
  const missingMap = new Map<string, ExpectedMissingFile>();

  for (const ref of references) {
    if (!loadedNames.has(ref.referencedFile)) {
      let entry = missingMap.get(ref.referencedFile);
      if (!entry) {
        entry = { name: ref.referencedFile, referencedBy: [] };
        missingMap.set(ref.referencedFile, entry);
      }
      entry.referencedBy.push(ref);
    }
  }

  return [...missingMap.values()];
}

/**
 * Remove entries that are accepted via workspace configuration.
 * - `config.files`: specific file names accepted as missing
 * - `config.sources`: source files whose outgoing references are suppressed
 *
 * @internal Exported for testing.
 */
export function filterAcceptedMissing(
  entries: ExpectedMissingFile[],
  config: AcceptedMissingConfig,
): ExpectedMissingFile[] {
  const acceptedFiles = new Set(config.files);
  const acceptedSources = new Set(config.sources);

  if (acceptedFiles.size === 0 && acceptedSources.size === 0) {
    return entries;
  }

  const result: ExpectedMissingFile[] = [];
  for (const entry of entries) {
    // Skip if the missing file itself is accepted
    if (acceptedFiles.has(entry.name)) continue;

    // Remove references from accepted sources
    const remainingRefs = entry.referencedBy.filter(
      (ref) => !acceptedSources.has(ref.sourceFile),
    );

    // If all references are suppressed, the entry disappears
    if (remainingRefs.length === 0) continue;

    result.push({ ...entry, referencedBy: remainingRefs });
  }
  return result;
}

/**
 * Build the "Total Overview" by aggregating all agent analyses. Shared by both
 * the Copilot and Claude analyzers.
 */
export function buildTotalAnalysis(agents: readonly AgentContextAnalysis[]): AgentContextAnalysis {
  // Deduplicate loaded files across agents (by name, keeping the richest entry)
  const fileMap = new Map<string, ContextFileEntry>();
  for (const agent of agents) {
    for (const file of agent.loadedFiles) {
      const existing = fileMap.get(file.name);
      if (!existing || (file.estimatedTokens ?? 0) > (existing.estimatedTokens ?? 0)) {
        fileMap.set(file.name, file);
      }
    }
  }

  // Deduplicate expected missing across agents
  const missingMap = new Map<string, ExpectedMissingFile>();
  for (const agent of agents) {
    for (const missing of agent.expectedMissing) {
      const existing = missingMap.get(missing.name);
      if (!existing) {
        missingMap.set(missing.name, missing);
      } else {
        // Merge referencedBy lists
        const existingSourceFiles = new Set(existing.referencedBy.map((r) => r.sourceFile));
        for (const ref of missing.referencedBy) {
          if (!existingSourceFiles.has(ref.sourceFile)) {
            existing.referencedBy.push(ref);
          }
        }
      }
    }
  }

  const loadedFiles = [...fileMap.values()];
  const expectedMissing = [...missingMap.values()];

  // Sum token budgets
  const totalContextTokens = agents.reduce((sum, a) => Math.max(sum, a.totalContextTokens), 0);
  const contextFileTokens = loadedFiles
    .filter((f) => f.status !== 'skipped')
    .reduce((sum, f) => sum + (f.estimatedTokens ?? 0), 0);
  const otherContextTokens = Math.max(0, totalContextTokens - contextFileTokens);

  const oversizedFiles = findOversizedFiles(loadedFiles);

  return {
    agentName: 'Total Overview',
    kind: 'total',
    loadedFiles,
    expectedMissing,
    totalContextTokens,
    contextFileTokens,
    otherContextTokens,
    oversizedFiles,
  };
}
