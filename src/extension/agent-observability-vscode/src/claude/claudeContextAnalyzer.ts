/**
 * Context analysis for a Claude Code session — the Claude counterpart to the
 * Copilot {@link ../context/contextAnalyzer.analyzeContext} path.
 *
 * Claude emits no discovery telemetry, so the loaded-context set is reconstructed
 * from the transcript plus the filesystem ({@link ./claudeContextDiscovery}) and
 * fed through the SAME source-agnostic analysis pipeline
 * ({@link ../context/contextAnalyzer.buildAgentAnalysisFromParts}). Partitioning is
 * trivial here: the main thread is one agent and each parsed sub-agent side-chain
 * is another, so there is no span-classification step.
 *
 * Token budget: Claude serves most of a turn's prompt from the cache, so the true
 * context-window occupancy is `input_tokens + cache_read + cache_creation`. We take
 * the largest such sum across an agent's turns as its representative window size —
 * the analogue of the Copilot analyzer's "largest input_tokens span".
 *
 * LOCAL-ONLY: transcript content and filesystem reads stay on-machine; nothing here
 * touches the cloud-aggregate path.
 */

import type { AcceptedMissingConfig, AgentContextParts } from '../context/contextAnalyzer';
import { buildAgentAnalysisFromParts, buildTotalAnalysis } from '../context/contextAnalyzer';
import type { AgentContextAnalysis, ContextFileEntry, SessionContextAnalysis } from '../context/models';
import type { ClaudeSessionInput } from './mapper';
import { defaultFs, type ClaudeFs } from './paths';
import type { TranscriptRecord } from './transcript';
import {
  detectContextToolReads,
  detectInvokedSkills,
  discoverMemoryFiles,
  resolveAgentDefinition,
} from './claudeContextDiscovery';

/**
 * Run the full context analysis for a Claude session. Returns `undefined` when
 * there is nothing worth showing (no context files detected and no token budget),
 * mirroring the Copilot analyzer's empty-data contract.
 */
export function analyzeClaudeContext(
  input: ClaudeSessionInput,
  acceptedMissing?: AcceptedMissingConfig,
  env: ClaudeFs = defaultFs,
): SessionContextAnalysis | undefined {
  const cwd = input.cwd;
  const agents: AgentContextAnalysis[] = [];

  // Main thread: always-in-context memory hierarchy + invoked skills + context reads.
  const mainDiscovery = dedupeByName([
    ...discoverMemoryFiles(cwd, env),
    ...detectInvokedSkills(input.mainRecords, cwd, env),
  ]);
  agents.push(
    buildAgentAnalysisFromParts(
      {
        agentName: 'Main agent',
        kind: 'main',
        discoveryFiles: mainDiscovery,
        toolReadRows: detectContextToolReads(input.mainRecords),
        systemInstructionsText: undefined,
        inputTokens: maxContextTokens(input.mainRecords),
      },
      acceptedMissing,
    ),
  );

  // Each sub-agent side-chain: its definition file + its own skills/reads.
  for (const sub of input.subagents) {
    const defFile = resolveAgentDefinition(sub.agentType, cwd, env);
    const discovery = dedupeByName([
      ...(defFile !== undefined ? [defFile] : []),
      ...detectInvokedSkills(sub.records, cwd, env),
    ]);
    const parts: AgentContextParts = {
      agentName: subagentName(sub.agentType),
      kind: 'subagent',
      discoveryFiles: discovery,
      toolReadRows: detectContextToolReads(sub.records),
      systemInstructionsText: undefined,
      inputTokens: maxContextTokens(sub.records),
    };
    agents.push(buildAgentAnalysisFromParts(parts, acceptedMissing));
  }

  const hasSignal = agents.some(
    (a) => a.loadedFiles.length > 0 || a.expectedMissing.length > 0 || a.totalContextTokens > 0,
  );
  if (!hasSignal) {
    return undefined;
  }

  return { total: buildTotalAnalysis(agents), agents };
}

// ── internals ────────────────────────────────────────────────────────────────

/**
 * Representative context-window token count for an agent: the largest
 * `input_tokens + cache_read + cache_creation` across its turns. Summing the three
 * captures the full prompt size, since Claude reports most of a cached prompt under
 * the cache buckets rather than `input_tokens`.
 */
function maxContextTokens(records: readonly TranscriptRecord[]): number {
  let max = 0;
  for (const record of records) {
    const usage = record.message?.usage;
    if (usage === undefined) {
      continue;
    }
    const total =
      num(usage.input_tokens) + num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens);
    if (total > max) {
      max = total;
    }
  }
  return max;
}

/** Friendly label matching the Claude Overview tab's agent-usage rows. */
function subagentName(agentType: string | undefined): string {
  return agentType !== undefined && agentType.length > 0 ? `Sub-agent: ${agentType}` : 'Sub-agent';
}

/** Keep the first entry per `name`; guards double-counting in size estimation. */
function dedupeByName(entries: readonly ContextFileEntry[]): ContextFileEntry[] {
  const seen = new Set<string>();
  const out: ContextFileEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.name)) {
      continue;
    }
    seen.add(entry.name);
    out.push(entry);
  }
  return out;
}

/** Finite non-negative number, else 0. */
function num(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}
