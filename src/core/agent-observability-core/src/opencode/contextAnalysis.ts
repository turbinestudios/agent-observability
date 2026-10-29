/**
 * Context analysis for an OpenCode session: the OpenCode counterpart to the
 * Claude ({@link ../claude/claudeContextAnalyzer}) and Copilot paths, fed
 * through the same source-agnostic pipeline
 * ({@link ../context/contextAnalyzer.buildAgentAnalysisFromParts}).
 *
 * Unlike Claude, OpenCode records what it loaded, so the instruction files
 * here are a point-in-time fact, sized from the text that was actually put in
 * the context:
 * - the files behind the session's `core/instructions` block (AGENTS.md,
 *   CLAUDE.md, configured instructions), at the start and as last updated;
 * - nested AGENTS.md files loaded as the agent worked in a sub-folder;
 * - skills loaded through the `skill` tool, resolved on disk for a size;
 * - context files the agent read with the `read` tool.
 *
 * Partitioning follows the Overview tab: the main thread is one agent, and the
 * sub-agent sessions are grouped by the agent they ran as.
 *
 * LOCAL-ONLY: paths and sizes stay on-machine; nothing here reaches the
 * aggregate path.
 */

import * as path from 'node:path';
import { defaultCopilotCliFs, type CopilotCliFs } from '../copilotCli/paths';
import type { AcceptedMissingConfig } from '../context/contextAnalyzer';
import { buildAgentAnalysisFromParts, buildTotalAnalysis } from '../context/contextAnalyzer';
import type { AgentContextAnalysis, ContextFileEntry, SessionContextAnalysis } from '../context/models';
import type { ToolReadRow } from '../context/toolCallDetector';
import { subagentName, type OpencodeSessionInput, type OpencodeThread } from './mapper';

const OPENCODE_CONTEXT_NOTE =
  "Instruction files are read from OpenCode's own record of what it loaded, sized from the text it loaded. "
  + 'Skills are counted when the agent loaded them and sized from the files on disk now; per-file token sizes are estimates.';

/** Where OpenCode looks for `<id>/SKILL.md`, relative to a project folder or the home folder. */
const SKILL_DIRS: readonly string[][] = [
  ['.opencode', 'skill'],
  ['.opencode', 'skills'],
  ['.claude', 'skills'],
  ['.agents', 'skills'],
];
const GLOBAL_SKILL_DIRS: readonly string[][] = [
  ['.config', 'opencode', 'skill'],
  ['.config', 'opencode', 'skills'],
  ['.claude', 'skills'],
  ['.agents', 'skills'],
];

/**
 * Run the context analysis for one OpenCode session. Returns `undefined` when
 * there is nothing worth showing (no context files and no token budget).
 */
export function analyzeOpencodeContext(
  input: OpencodeSessionInput,
  acceptedMissing?: AcceptedMissingConfig,
  env: CopilotCliFs = defaultCopilotCliFs,
): SessionContextAnalysis | undefined {
  const cwd = input.session.directory ?? input.session.worktree;
  const agents: AgentContextAnalysis[] = [analyzeAgent('Main agent', 'main', [input], cwd, env, acceptedMissing)];

  const byAgent = new Map<string, OpencodeThread[]>();
  for (const child of input.children) {
    const name = subagentName(child);
    byAgent.set(name, [...(byAgent.get(name) ?? []), child]);
  }
  for (const [name, threads] of [...byAgent.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    agents.push(analyzeAgent(`Sub-agent: ${name}`, 'subagent', threads, cwd, env, acceptedMissing));
  }

  const hasSignal = agents.some(
    (a) => a.loadedFiles.length > 0 || a.expectedMissing.length > 0 || a.totalContextTokens > 0,
  );
  if (!hasSignal) {
    return undefined;
  }
  return { total: buildTotalAnalysis(agents), agents, note: OPENCODE_CONTEXT_NOTE };
}

function analyzeAgent(
  agentName: string,
  kind: 'main' | 'subagent',
  threads: readonly OpencodeThread[],
  cwd: string | undefined,
  env: CopilotCliFs,
  acceptedMissing: AcceptedMissingConfig | undefined,
): AgentContextAnalysis {
  const discovery: ContextFileEntry[] = [];
  const seen = new Set<string>();
  const add = (entry: ContextFileEntry, key: string): void => {
    if (!seen.has(key)) {
      seen.add(key);
      discovery.push(entry);
    }
  };

  for (const thread of threads) {
    for (const load of thread.instructions) {
      const filePath = path.normalize(load.path);
      add(
        {
          name: path.basename(filePath),
          filePath,
          category: 'instruction',
          status: 'applied',
          ...(load.chars !== undefined ? { charCount: load.chars } : {}),
        },
        `file:${filePath.toLowerCase()}`,
      );
    }
    for (const tool of thread.tools) {
      if (tool.skillId === undefined) {
        continue;
      }
      const filePath = resolveSkill(tool.skillId, cwd, env);
      add(
        { name: tool.skillId, category: 'skill', status: 'applied', ...(filePath !== undefined ? { filePath } : {}) },
        `skill:${tool.skillId}`,
      );
    }
  }

  const toolReadRows: ToolReadRow[] = threads.flatMap((t) =>
    t.tools
      .filter((tool) => tool.contextPath !== undefined)
      .map((tool) => ({ filePath: tool.contextPath as string, conversationId: null, chatSessionId: null })),
  );

  return buildAgentAnalysisFromParts(
    {
      agentName,
      kind,
      discoveryFiles: uniquifyNames(discovery),
      toolReadRows,
      systemInstructionsText: undefined,
      inputTokens: maxContextTokens(threads),
    },
    acceptedMissing,
  );
}

/**
 * Representative context-window size: the largest prompt any one call sent,
 * `input + cache read + cache write`, since most of a long session's prompt is
 * served from the cache.
 */
function maxContextTokens(threads: readonly OpencodeThread[]): number {
  let max = 0;
  for (const thread of threads) {
    for (const m of thread.messages) {
      if (m.role === 'assistant') {
        max = Math.max(max, m.inputTokens + m.cacheReadTokens + m.cacheWriteTokens);
      }
    }
  }
  return max;
}

/** A skill's `SKILL.md`: the project folders from `cwd` upwards first, then the home folder. */
function resolveSkill(id: string, cwd: string | undefined, env: CopilotCliFs): string | undefined {
  if (id.includes('/') || id.includes('\\') || id.includes('..')) {
    return undefined;
  }
  const candidates: string[] = [];
  if (cwd !== undefined && cwd.length > 0) {
    let dir = path.normalize(cwd);
    for (let guard = 0; guard < 64; guard++) {
      for (const parts of SKILL_DIRS) {
        candidates.push(path.join(dir, ...parts, id, 'SKILL.md'));
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }
  const home = env.homedir();
  if (home.length > 0) {
    for (const parts of GLOBAL_SKILL_DIRS) {
      candidates.push(path.join(home, ...parts, id, 'SKILL.md'));
    }
  }
  return candidates.find((file) => env.stat(file) !== undefined);
}

/**
 * Several AGENTS.md files load in a monorepo; name each by its folder so the
 * tab's rows (and the Total's de-duplication) tell them apart.
 */
function uniquifyNames(entries: ContextFileEntry[]): ContextFileEntry[] {
  const counts = new Map<string, number>();
  for (const e of entries) {
    counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
  }
  return entries.map((e) =>
    (counts.get(e.name) ?? 0) > 1 && e.filePath !== undefined
      ? { ...e, name: `${path.basename(path.dirname(e.filePath))}/${e.name}` }
      : e,
  );
}
