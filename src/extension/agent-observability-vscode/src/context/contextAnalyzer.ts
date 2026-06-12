/**
 * Context analysis orchestrator — combines discovery parsing, tool-call detection,
 * reference resolution, and size estimation into a complete per-agent and
 * aggregated context analysis for a session.
 *
 * LOCAL-ONLY: all analysis is performed on-machine. The resulting
 * {@link SessionContextAnalysis} is rendered in the local webview only.
 */

import type { TelemetryService } from '../telemetry/telemetryService';
import type {
  AgentContextAnalysis,
  ContextFileEntry,
  ExpectedMissingFile,
  SessionContextAnalysis,
} from './models';
import { parseDiscoveryEvents, type DiscoveryEventRow } from './discoveryParser';
import { parseToolReads } from './toolCallDetector';
import { resolveReferences } from './referenceResolver';
import { estimateContextSizes, findOversizedFiles } from './sizeEstimator';

/**
 * Run the full context analysis pipeline for a session.
 *
 * @param sessionKey - The session to analyze
 * @param telemetry - Telemetry service for database access
 * @returns Complete context analysis, or undefined if no data available
 */
export function analyzeContext(
  sessionKey: string,
  telemetry: TelemetryService,
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

  // 2. Partition events by agent (main vs subagents)
  // Main agent: conversation_id === chat_session_id, or the root session
  // Subagents: conversation_id !== chat_session_id (spawned under a different id)
  const agentPartitions = partitionByAgent(discoveryEvents, toolReads, systemInstrMap);

  // 3. Build per-agent analyses
  const agents: AgentContextAnalysis[] = [];
  for (const partition of agentPartitions) {
    const analysis = buildAgentAnalysis(partition);
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
  toolReads: Array<{ filePath: string; conversationId: string | null; chatSessionId: string | null }>;
  systemInstructionsText: string | undefined;
  inputTokens: number;
}

/**
 * Partition raw data by agent. Events in the root conversation are "main";
 * events in spawned sub-conversations are per-subagent.
 */
function partitionByAgent(
  discoveryEvents: DiscoveryEventRow[],
  toolReads: Array<{ filePath: string; conversationId: string | null; chatSessionId: string | null }>,
  systemInstrMap: Map<string, { value: string; conversationId: string | null; chatSessionId: string | null; inputTokens: number }>,
): AgentPartition[] {
  // Group by chat_session_id (each subagent gets its own chat_session_id)
  const sessionIdGroups = new Map<string, AgentPartition>();

  // Determine the "main" session: the one where conversation_id === chat_session_id,
  // or the first/most common chat_session_id.
  const mainSessionId = detectMainSessionId(discoveryEvents, toolReads, systemInstrMap);

  // Process discovery events
  for (const event of discoveryEvents) {
    const sessionId = event.chatSessionId ?? event.conversationId ?? 'unknown';
    const isMain = sessionId === mainSessionId || event.conversationId === event.chatSessionId;
    const key = isMain ? '__main__' : sessionId;

    let partition = sessionIdGroups.get(key);
    if (!partition) {
      partition = {
        agentName: isMain ? 'Main Agent' : `Subagent`,
        kind: isMain ? 'main' : 'subagent',
        discoveryEvents: [],
        toolReads: [],
        systemInstructionsText: undefined,
        inputTokens: 0,
      };
      sessionIdGroups.set(key, partition);
    }
    partition.discoveryEvents.push(event);
  }

  // Process tool reads
  for (const read of toolReads) {
    const sessionId = read.chatSessionId ?? read.conversationId ?? 'unknown';
    const isMain = sessionId === mainSessionId || read.conversationId === read.chatSessionId;
    const key = isMain ? '__main__' : sessionId;

    let partition = sessionIdGroups.get(key);
    if (!partition) {
      partition = {
        agentName: isMain ? 'Main Agent' : `Subagent`,
        kind: isMain ? 'main' : 'subagent',
        discoveryEvents: [],
        toolReads: [],
        systemInstructionsText: undefined,
        inputTokens: 0,
      };
      sessionIdGroups.set(key, partition);
    }
    partition.toolReads.push(read);
  }

  // Process system instructions (take the first per agent — they're consistent within a conversation)
  for (const [, entry] of systemInstrMap) {
    const sessionId = entry.chatSessionId ?? entry.conversationId ?? 'unknown';
    const isMain = sessionId === mainSessionId || entry.conversationId === entry.chatSessionId;
    const key = isMain ? '__main__' : sessionId;

    let partition = sessionIdGroups.get(key);
    if (!partition) {
      partition = {
        agentName: isMain ? 'Main Agent' : `Subagent`,
        kind: isMain ? 'main' : 'subagent',
        discoveryEvents: [],
        toolReads: [],
        systemInstructionsText: undefined,
        inputTokens: 0,
      };
      sessionIdGroups.set(key, partition);
    }
    // Use first system_instructions for this agent (they're typically consistent)
    if (!partition.systemInstructionsText) {
      partition.systemInstructionsText = entry.value;
      partition.inputTokens = entry.inputTokens;
    }
  }

  // Ensure main partition exists
  if (!sessionIdGroups.has('__main__')) {
    sessionIdGroups.set('__main__', {
      agentName: 'Main Agent',
      kind: 'main',
      discoveryEvents: [],
      toolReads: [],
      systemInstructionsText: undefined,
      inputTokens: 0,
    });
  }

  // Sort: main first, then subagents
  const partitions = [...sessionIdGroups.values()];
  partitions.sort((a, b) => {
    if (a.kind === 'main' && b.kind !== 'main') return -1;
    if (a.kind !== 'main' && b.kind === 'main') return 1;
    return a.agentName.localeCompare(b.agentName);
  });

  return partitions;
}

/**
 * Detect the main session ID (the root conversation).
 * Heuristic: first event where conversation_id === chat_session_id, or the most
 * common chat_session_id.
 */
function detectMainSessionId(
  discoveryEvents: DiscoveryEventRow[],
  toolReads: Array<{ filePath: string; conversationId: string | null; chatSessionId: string | null }>,
  systemInstrMap: Map<string, { value: string; conversationId: string | null; chatSessionId: string | null; inputTokens: number }>,
): string | null {
  // Check discovery events first
  for (const event of discoveryEvents) {
    if (event.conversationId && event.conversationId === event.chatSessionId) {
      return event.chatSessionId;
    }
  }

  // Check system_instructions
  for (const [, entry] of systemInstrMap) {
    if (entry.conversationId && entry.conversationId === entry.chatSessionId) {
      return entry.chatSessionId;
    }
  }

  // Fallback: most common chat_session_id
  const counts = new Map<string, number>();
  for (const event of discoveryEvents) {
    const id = event.chatSessionId;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const read of toolReads) {
    const id = read.chatSessionId;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  let maxId: string | null = null;
  let maxCount = 0;
  for (const [id, count] of counts) {
    if (count > maxCount) {
      maxCount = count;
      maxId = id;
    }
  }
  return maxId;
}

/**
 * Build a single agent's context analysis from its partition of data.
 */
function buildAgentAnalysis(partition: AgentPartition): AgentContextAnalysis {
  // Parse discovery events into file entries
  const discoveryFiles = parseDiscoveryEvents(partition.discoveryEvents);

  // Detect additional files from tool reads
  const knownNames = new Set(discoveryFiles.map((f) => f.name));
  const toolReadFiles = parseToolReads(partition.toolReads, knownNames);

  // Combine all loaded files
  const allFiles = [...discoveryFiles, ...toolReadFiles];

  // Resolve cross-references (only among applied/read files)
  const appliedFiles = allFiles.filter((f) => f.status !== 'skipped');
  const references = resolveReferences(appliedFiles, partition.systemInstructionsText);

  // Detect expected-but-missing files
  const loadedNames = new Set(allFiles.filter((f) => f.status !== 'skipped').map((f) => f.name));
  const expectedMissing = detectExpectedMissing(references, loadedNames);

  // Estimate sizes
  const { entries, totalContextTokens, contextFileTokens, otherContextTokens } =
    estimateContextSizes(allFiles, partition.systemInstructionsText, partition.inputTokens);

  // Find oversized files
  const oversizedFiles = findOversizedFiles(entries);

  return {
    agentName: partition.agentName,
    kind: partition.kind,
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
 * Build the "Total Overview" by aggregating all agent analyses.
 */
function buildTotalAnalysis(agents: readonly AgentContextAnalysis[]): AgentContextAnalysis {
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
