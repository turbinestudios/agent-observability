/**
 * The repository digest: "what the agents learned here", built entirely from
 * the counts the desktop index already holds, with no model call.
 *
 * PURE and import-free (no `node:*`): the renderer imports it to render the
 * Markdown in a dialog, the same way it imports `context/improvePrompt.ts`.
 * The input is already content-free by construction — repo-relative context
 * paths, theme labels from the static finding table, tip sentences from the
 * static advice table, model and tool names — and this module adds no path
 * or branch logic, so the output can be copied into a retro without review.
 *
 * Numbers are formatted by hand (no `Intl`) so the digest reads identically on
 * every machine, matching the rule in AGENTS.md.
 */

import { OVERSIZED_THRESHOLD_TOKENS } from '../context/models';

export type DigestVerdict = 'smooth' | 'bumpy' | 'struggled' | 'abandoned' | 'unjudged';

export type DigestVerdictCounts = Record<DigestVerdict, number>;

export interface RepositoryDigestInput {
  repository: string;
  windowDays: number;
  generatedAtMs: number;
  sessions: {
    total: number;
    previousTotal: number;
    bySource: { source: string; sessions: number }[];
    verdicts: DigestVerdictCounts;
    previousVerdicts: DigestVerdictCounts;
  };
  themes: {
    signalId: string;
    label: string;
    sessions: number;
    previousSessions: number;
    occurrences: number;
  }[];
  /** Static advice tips ranked by how many sessions fired them. */
  tips: { id: string; text: string; sessions: number }[];
  /** Context files agents loaded, repo-relative or short names, NEVER absolute. */
  hotspots: {
    path: string;
    category: string;
    sessionCount: number;
    appliedCount: number;
    skippedCount: number;
    estTokensMax: number;
  }[];
  models: { model: string; sessions: number; costMicros: number | null }[];
  /** Optional: the section is omitted when absent. */
  tools?: { name: string; calls: number; failures: number; sampledSessions: number }[];
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    costMicros: number;
    /** How many of the window's sessions carry a cost estimate. */
    costSessions: number;
  };
  /** Context files found on disk, joined with how often sessions loaded them. */
  contextFiles: {
    relPath: string;
    kind: string;
    agent: string;
    estTokens: number;
    seenInSessions: number;
    skippedCount: number;
  }[];
}

export interface RepositoryDigest {
  headline: string;
  sections: { title: string; lines: string[] }[];
  input: RepositoryDigestInput;
}

const VERDICT_ORDER: readonly DigestVerdict[] = ['smooth', 'bumpy', 'struggled', 'abandoned', 'unjudged'];
const NONE_YET = '(none yet)';
const MAX_THEMES = 5;
const MAX_TIPS = 3;
const MAX_HOTSPOTS = 5;
const MAX_UNUSED_FILES = 10;
const MAX_MODELS = 5;
const MAX_TOOLS = 8;

/** Build the digest sections from the counts. Pure; `generatedAtMs` is echoed only. */
export function buildRepositoryDigest(input: RepositoryDigestInput): RepositoryDigest {
  return {
    headline: `What agents learned in ${clean(input.repository)} (last ${input.windowDays} days)`,
    sections: [
      { title: 'How sessions went', lines: sessionLines(input) },
      { title: 'Recurring friction', lines: themeLines(input) },
      { title: 'What usually helps here', lines: tipLines(input) },
      { title: 'Context files agents actually use', lines: hotspotLines(input) },
      { title: 'Context files on disk', lines: contextFileLines(input) },
      { title: 'Models and tools', lines: modelAndToolLines(input) },
      { title: 'Spend', lines: spendLines(input) },
    ],
    input,
  };
}

/** Render the digest as Markdown fit to paste into a retro or a wiki page. */
export function renderRepositoryDigestMarkdown(digest: RepositoryDigest): string {
  const lines: string[] = [`# ${digest.headline}`, ''];
  for (const section of digest.sections) {
    lines.push(`## ${section.title}`, '');
    for (const line of section.lines) {
      lines.push(`- ${line}`);
    }
    lines.push('');
  }
  lines.push('_Generated locally by Agent Observability; no session content included._', '');
  return lines.join('\n');
}

// ── Sections ────────────────────────────────────────────────────────────────

function sessionLines(input: RepositoryDigestInput): string[] {
  const { sessions } = input;
  if (sessions.total === 0) {
    return [NONE_YET];
  }
  const lines: string[] = [];
  const sourceSummary = sessions.bySource
    .filter((s) => s.sessions > 0)
    .map((s) => `${groupThousands(s.sessions)} ${sourceLabel(s.source)}`)
    .join(', ');
  lines.push(
    `${groupThousands(sessions.total)} ${plural(sessions.total, 'session')} (${trendLabel(sessions.total, sessions.previousTotal, 'session')})` +
      (sourceSummary.length > 0 ? `: ${sourceSummary}` : ''),
  );
  const total = sumVerdicts(sessions.verdicts);
  const previousTotal = sumVerdicts(sessions.previousVerdicts);
  for (const verdict of VERDICT_ORDER) {
    const count = sessions.verdicts[verdict] ?? 0;
    if (count === 0) {
      continue;
    }
    const share = percent(count, total);
    const previous = sessions.previousVerdicts[verdict] ?? 0;
    const was = previousTotal > 0 ? ` (was ${percent(previous, previousTotal)}%)` : '';
    lines.push(`${verdictLabel(verdict)} ${share}%${was}: ${groupThousands(count)} ${plural(count, 'session')}`);
  }
  return lines;
}

function themeLines(input: RepositoryDigestInput): string[] {
  const themes = [...input.themes].filter((t) => t.sessions > 0).sort((a, b) => b.sessions - a.sessions).slice(0, MAX_THEMES);
  if (themes.length === 0) {
    return [NONE_YET];
  }
  return themes.map(
    (t) =>
      `${clean(t.label)}: ${groupThousands(t.sessions)} ${plural(t.sessions, 'session')}, ` +
      `${groupThousands(t.occurrences)} ${plural(t.occurrences, 'occurrence')} (${trendLabel(t.sessions, t.previousSessions, 'session')})`,
  );
}

function tipLines(input: RepositoryDigestInput): string[] {
  const tips = [...input.tips].filter((t) => t.sessions > 0).sort((a, b) => b.sessions - a.sessions).slice(0, MAX_TIPS);
  if (tips.length === 0) {
    return [NONE_YET];
  }
  return tips.map((t) => `Fired in ${groupThousands(t.sessions)} ${plural(t.sessions, 'session')}. ${clean(t.text)}`);
}

function hotspotLines(input: RepositoryDigestInput): string[] {
  const hotspots = [...input.hotspots]
    .filter((h) => h.sessionCount > 0)
    .sort((a, b) => b.sessionCount - a.sessionCount)
    .slice(0, MAX_HOTSPOTS);
  if (hotspots.length === 0) {
    return [NONE_YET];
  }
  return hotspots.map((h) => {
    const loads = h.appliedCount + h.skippedCount;
    const skipRate = loads > 0 ? `${percent(h.skippedCount, loads)}% skipped` : 'no loads recorded';
    const oversized = h.estTokensMax > OVERSIZED_THRESHOLD_TOKENS ? ', oversized' : '';
    return (
      `\`${clean(h.path)}\` (${clean(h.category)}): ${groupThousands(h.sessionCount)} ${plural(h.sessionCount, 'session')}, ` +
      `${skipRate}, up to ~${groupThousands(h.estTokensMax)} tokens${oversized}`
    );
  });
}

function contextFileLines(input: RepositoryDigestInput): string[] {
  if (input.contextFiles.length === 0) {
    return [NONE_YET];
  }
  const byKind = new Map<string, number>();
  for (const file of input.contextFiles) {
    byKind.set(file.kind, (byKind.get(file.kind) ?? 0) + 1);
  }
  const counts = [...byKind.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([kind, count]) => `${groupThousands(count)} ${clean(kind)}`)
    .join(', ');
  const lines = [`${groupThousands(input.contextFiles.length)} ${plural(input.contextFiles.length, 'file')} on disk: ${counts}`];
  const unused = input.contextFiles.filter((f) => f.seenInSessions === 0).sort(byRelPath);
  if (unused.length > 0) {
    const shown = unused.slice(0, MAX_UNUSED_FILES).map((f) => `\`${clean(f.relPath)}\``);
    const more = unused.length > MAX_UNUSED_FILES ? ` and ${groupThousands(unused.length - MAX_UNUSED_FILES)} more` : '';
    lines.push(`Unused by agents so far: ${shown.join(', ')}${more}`);
  }
  return lines;
}

function modelAndToolLines(input: RepositoryDigestInput): string[] {
  const lines: string[] = [];
  const models = [...input.models].filter((m) => m.sessions > 0).sort((a, b) => b.sessions - a.sessions).slice(0, MAX_MODELS);
  for (const model of models) {
    const cost = model.costMicros !== null ? `, est. ${formatUsd(model.costMicros)}` : '';
    lines.push(`${clean(model.model)}: ${groupThousands(model.sessions)} ${plural(model.sessions, 'session')}${cost}`);
  }
  if (input.tools !== undefined) {
    const tools = [...input.tools].filter((t) => t.calls > 0).sort((a, b) => b.calls - a.calls).slice(0, MAX_TOOLS);
    const sampled = input.tools.reduce((max, t) => Math.max(max, t.sampledSessions), 0);
    for (const tool of tools) {
      const failures = tool.failures > 0 ? `, ${groupThousands(tool.failures)} failed` : '';
      lines.push(
        `Tool ${clean(tool.name)}: ${groupThousands(tool.calls)} ${plural(tool.calls, 'call')}${failures} ` +
          `(sampled from the ${groupThousands(sampled)} most recent ${plural(sampled, 'session')})`,
      );
    }
  }
  return lines.length > 0 ? lines : [NONE_YET];
}

function spendLines(input: RepositoryDigestInput): string[] {
  const { tokens, sessions } = input;
  if (sessions.total === 0 && tokens.inputTokens === 0 && tokens.outputTokens === 0) {
    return [NONE_YET];
  }
  const lines = [
    `${groupThousands(tokens.inputTokens)} input, ${groupThousands(tokens.outputTokens)} output, ` +
      `${groupThousands(tokens.cachedTokens)} cached tokens`,
  ];
  if (tokens.costSessions > 0) {
    lines.push(
      `Est. ${formatUsd(tokens.costMicros)} across ${groupThousands(tokens.costSessions)} of ` +
        `${groupThousands(sessions.total)} ${plural(sessions.total, 'session')} priced`,
    );
  } else {
    lines.push('No cost estimate available for these sessions');
  }
  return lines;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** `+3 sessions`, `-2 sessions`, or `no change` against the previous window. */
export function trendLabel(current: number, previous: number, noun: string): string {
  const delta = current - previous;
  if (delta === 0) {
    return 'no change';
  }
  const sign = delta > 0 ? '+' : '-';
  const magnitude = Math.abs(delta);
  return `${sign}${groupThousands(magnitude)} ${plural(magnitude, noun)}`;
}

/** Whole-number percentage, 0 when the denominator is 0. */
export function percent(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

function sumVerdicts(counts: DigestVerdictCounts): number {
  return VERDICT_ORDER.reduce((sum, v) => sum + (counts[v] ?? 0), 0);
}

function verdictLabel(verdict: DigestVerdict): string {
  switch (verdict) {
    case 'smooth':
      return 'Smooth';
    case 'bumpy':
      return 'Bumpy';
    case 'struggled':
      return 'Struggled';
    case 'abandoned':
      return 'Abandoned';
    case 'unjudged':
      return 'Not judged';
  }
}

function sourceLabel(source: string): string {
  switch (source) {
    case 'claude':
      return 'Claude Code';
    case 'copilot':
      return 'Copilot';
    default:
      return clean(source);
  }
}

function byRelPath(a: { relPath: string }, b: { relPath: string }): number {
  return a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0;
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

/** Micro-USD → `$12.34`, by hand so it reads the same everywhere. */
export function formatUsd(micros: number): string {
  const cents = Math.round(micros / 10_000);
  const dollars = Math.floor(cents / 100);
  const rest = cents % 100;
  return `$${groupThousands(dollars)}.${rest < 10 ? `0${rest}` : String(rest)}`;
}

/**
 * `12345` → `12,345`, the same everywhere (no `Intl`). Duplicated from
 * `context/improvePrompt.ts`, where it is private, rather than widening that
 * module's surface for an eight-line helper.
 */
function groupThousands(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Flatten to one line and strip backticks so a label cannot break out of its bullet. */
function clean(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f`]/g, ' ').replace(/\s+/g, ' ').trim();
}
