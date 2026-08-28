/**
 * Grounding for the AI Helper chat: the preamble that puts the user's local
 * session data in front of the model, assembled fresh for every send.
 *
 * PRIVACY: the preamble CONTAINS raw session content — titles, repositories,
 * and (for an attached focus session) capped transcript excerpts from
 * `transcriptDigest.ts`. It may only ever reach a model through the AI
 * Helper's sanctioned, gated exception in AGENTS.md's privacy invariant; the
 * desktop datahost owns that gate. Pure by design: no environment access, no
 * I/O — everything the preamble says arrives through the parameters, which is
 * what guarantees no API key or ambient secret can leak into a prompt.
 */

/** One session as the assistant may see and cite it. */
export interface AssistantSessionRow {
  /** Stable citation handle for THIS prompt ("S1", "S2", …). */
  ref: string;
  source: string;
  sessionId: string;
  title?: string;
  repository: string;
  startedAtMs: number;
  durationMs: number;
  interactionCount: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  model: string;
  /** Retro verdict when the background analysis has judged the session. */
  verdict?: string;
  deviationCount?: number;
  costMicros?: number;
}

/** A session the user attached to the conversation, digest included. */
export interface AssistantFocus {
  row: AssistantSessionRow;
  /** Capped transcript digest lines (see `transcriptDigest.ts`). */
  digest: string[];
}

/** One canned question offered by the empty chat. */
export interface AssistantQuickPrompt {
  id: string;
  label: string;
  prompt: string;
}

/** How many recent sessions ground every send (~120 chars per line ≈ 5 KB). */
export const CORPUS_SESSION_LIMIT = 40;

/** Character budget for replayed history (see `truncateHistory`). */
export const HISTORY_MAX_CHARS = 24_000;

/** The canned questions on the empty chat. */
export const ASSISTANT_QUICK_PROMPTS: readonly AssistantQuickPrompt[] = [
  {
    id: 'recent-activity',
    label: 'What have I worked on?',
    prompt: 'What have I worked on recently, and how did it go overall?',
  },
  {
    id: 'friction',
    label: 'Where was the friction?',
    prompt: 'Which recent sessions struggled or were left unfinished, and what patterns explain the friction?',
  },
  {
    id: 'spend',
    label: 'Where do tokens go?',
    prompt: 'Where are my tokens and cost going? Which sessions, repositories, and models dominate?',
  },
];

/**
 * Build the grounding preamble for one send. `rows` are the recent sessions
 * (newest first, refs already assigned); `focus` is the attached session, if
 * any; `historyTruncated` notes that older conversation turns were dropped.
 */
export function buildAssistantPreamble(
  rows: readonly AssistantSessionRow[],
  focus: AssistantFocus | undefined,
  historyTruncated: boolean,
  nowMs: number,
): string {
  const lines: string[] = [
    "You are the AI Helper inside Agent Observability, a local app a developer uses to study their own coding-agent sessions (Claude Code, GitHub Copilot).",
    'Answer their questions using ONLY the session data below. When the data cannot answer something, say so plainly instead of guessing.',
    'Cite sessions by their bracketed ref (for example [S3]) whenever an answer draws on one — the refs are defined in the list below and become clickable links.',
    'Be concrete and concise: name sessions, repositories, and numbers rather than generalities. Address the setup and the prompts, never the developer.',
    '',
    `Current time: ${new Date(nowMs).toISOString()}`,
    '',
    '# Recent sessions (newest first)',
  ];
  if (rows.length === 0) {
    lines.push('(no sessions indexed yet)');
  }
  for (const row of rows) {
    lines.push(sessionLine(row));
  }
  lines.push('', '# Totals over the sessions listed', totalsLine(rows));
  if (focus !== undefined) {
    lines.push(
      '',
      `# Focus session [${focus.row.ref}]`,
      'The developer attached this session to the conversation; questions about "this session" or "this run" mean it.',
      sessionLine(focus.row),
      '',
      '## Transcript digest',
      ...focus.digest,
    );
  }
  if (historyTruncated) {
    lines.push('', '(Earlier turns of this conversation were omitted for length.)');
  }
  return lines.join('\n');
}

/** What a citation ref resolves to: the session, plus the label the UI shows for it. */
export interface SessionRefTarget {
  source: string;
  sessionId: string;
  /** Human-readable name — the title when there is one, the ref otherwise. */
  label: string;
}

/** The citation map for one send: ref → session, focus included. */
export function buildSessionRefMap(
  rows: readonly AssistantSessionRow[],
  focus?: AssistantFocus,
): Map<string, SessionRefTarget> {
  const map = new Map<string, SessionRefTarget>();
  for (const row of rows) {
    map.set(row.ref, targetOf(row));
  }
  if (focus !== undefined) {
    map.set(focus.row.ref, targetOf(focus.row));
  }
  return map;
}

function targetOf(row: AssistantSessionRow): SessionRefTarget {
  const title = row.title?.trim() ?? '';
  return {
    source: row.source,
    sessionId: row.sessionId,
    label: title.length > 0 ? title : row.ref,
  };
}

/** `[S1] 2026-08-28T14:05Z · 45m · claude · repo · "title" · 12 turns · …` */
function sessionLine(row: AssistantSessionRow): string {
  const parts: string[] = [
    `[${row.ref}]`,
    isoMinute(row.startedAtMs),
    formatDuration(row.durationMs),
    row.source,
    row.repository,
  ];
  if (row.title !== undefined && row.title.trim().length > 0) {
    parts.push(`"${row.title.trim()}"`);
  }
  parts.push(
    `${row.interactionCount} turns`,
    `${row.toolCalls} tool calls`,
    `${formatCount(row.inputTokens)} in / ${formatCount(row.outputTokens)} out tokens`,
    row.model,
  );
  if (row.verdict !== undefined) {
    parts.push(row.verdict);
  }
  if (row.deviationCount !== undefined && row.deviationCount > 0) {
    parts.push(`${row.deviationCount} deviations`);
  }
  if (row.costMicros !== undefined && row.costMicros > 0) {
    parts.push(formatCost(row.costMicros));
  }
  return parts.join(' · ');
}

function totalsLine(rows: readonly AssistantSessionRow[]): string {
  let input = 0;
  let output = 0;
  let cost = 0;
  for (const row of rows) {
    input += row.inputTokens;
    output += row.outputTokens;
    cost += row.costMicros ?? 0;
  }
  const parts = [
    `${rows.length} sessions`,
    `${formatCount(input)} input tokens`,
    `${formatCount(output)} output tokens`,
  ];
  if (cost > 0) {
    parts.push(`${formatCost(cost)} total cost`);
  }
  return parts.join(' · ');
}

/** ISO timestamp to the minute — compact, unambiguous, model-computable. */
function isoMinute(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16) + 'Z';
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  return `${Math.floor(minutes / 60)}h${minutes % 60 > 0 ? `${minutes % 60}m` : ''}`;
}

function formatCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return String(value);
}

function formatCost(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}
