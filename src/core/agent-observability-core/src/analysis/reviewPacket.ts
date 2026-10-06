import { quoteLineCounted } from '../text/redact';
import type { CostMode, SessionDetail } from '../telemetry/models';
import type { CompletionCheck, CompletionStatus } from './completionCheck';
import { formatUsd } from './repositoryDigest';
import type { SessionOutcome, SessionRetrospective, SessionVerdict } from './retrospective';
import {
  RISK_RULES,
  detectCommandRisks,
  detectPathRisks,
  isBypassPermissionMode,
  commandOutcome,
  isVerificationClass,
  rollupFiles,
  type CommandClass,
  type FileRollup,
  type RepoPathFn,
  type RiskId,
  type SessionActivity,
} from './sessionActivity';

/**
 * The review packet: what a human reviewer should read BEFORE the diff of an
 * agent-written change — what was asked, what changed and how often it was
 * re-edited, what ran and failed, how it was checked, where it went wrong.
 *
 * Built on this machine with no AI, as a pure function over data the app
 * already holds. Split like `repositoryDigest.ts`: {@link buildReviewPacket}
 * produces a structured packet, {@link renderReviewPacketMarkdown} turns one
 * or several into Markdown the user copies to the clipboard themselves.
 *
 * Content rules, enforced here by construction:
 * - Every quoted string (a request line, a goal taken from a prompt, a risky
 *   command) passes through `quoteLineCounted`: redacted, one line, capped.
 * - Paths go through the injected {@link RepoPathFn}; a path outside the
 *   repository arrives already reduced to its name. No absolute path, branch
 *   name or tool output is ever read or emitted.
 * - `includePrompts: false` removes every line of the user's own prompt text.
 * - Numbers and durations are formatted by hand (no `Intl`); no dates.
 */

export const PACKET_TURN_LINE_MAX_CHARS = 140;
export const PACKET_GOAL_MAX_CHARS = 300;
export const PACKET_MAX_TURNS = 40;
export const PACKET_MAX_FILES = 30;
export const PACKET_MAX_RISKS = 15;
export const PACKET_COMMAND_QUOTE_MAX_CHARS = 120;
export const PACKET_MAX_DEAD_ENDS = 10;
export const PACKET_MAX_CHARS = 20_000;
/** GitHub pull-request bodies stop at 65,536 characters. */
export const PACKET_MULTI_MAX_CHARS = 60_000;

export interface ReviewPacketInput {
  detail: SessionDetail;
  retrospective: SessionRetrospective;
  activity: SessionActivity;
  completion?: CompletionCheck;
  repository: string;
  title?: string;
  toRepoPath: RepoPathFn;
  costMode: CostMode;
}

export type PacketTurnOutcome = 'ok' | 'failed' | 'corrected' | 'interrupted';
export type PacketDeadEndKind = 'correction' | 'interruption' | 'error-streak' | 'repeated-prompt';

export interface ReviewPacket {
  source: string;
  sessionId: string;
  repository: string;
  title?: string;
  goal?: { text: string; fromPrompt: boolean };
  turns: { index: number; line?: string; outcome: PacketTurnOutcome }[];
  turnsOmitted: number;
  files: FileRollup[];
  filesOmitted: number;
  /** False when the source cannot see tool inputs (no file or command detail). */
  filesAvailable: boolean;
  commands: { class: CommandClass; runs: number; failures: number }[];
  verification: {
    status: CompletionStatus | 'not-checked';
    testRuns: number;
    testFailures: number;
    lastTestFailed?: boolean;
    checks: { label: string; passed: boolean }[];
  };
  deadEnds: { turnIndex: number; kind: PacketDeadEndKind; note: string }[];
  risks: { id: RiskId; label: string; turnIndex?: number; count: number; quote?: string }[];
  risksOmitted: number;
  subAgents: { name: string; calls: number; tokenSharePct?: number }[];
  models: { model: string; inputTokens: number; outputTokens: number }[];
  totals: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    costMicros?: number;
    durationMs: number;
    turns: number;
  };
  costMode: CostMode;
  verdict: SessionVerdict;
  outcome: SessionOutcome;
  findings: { severity: string; text: string }[];
  tips: string[];
  /** Secret-looking strings replaced across everything quoted. */
  redactions: number;
}

export interface ReviewPacketOptions {
  includePrompts: boolean;
}

const DEAD_END_KINDS: Readonly<Record<string, PacketDeadEndKind>> = {
  'correction-reprompt': 'correction',
  'user-interruption': 'interruption',
  'tool-error-streak': 'error-streak',
  'repeated-prompt': 'repeated-prompt',
};

const CLASS_ORDER: readonly CommandClass[] = [
  'test',
  'typecheck',
  'lint',
  'build',
  'install',
  'git',
  'run',
  'network',
  'filesystem',
  'other',
];

/** Build the structured packet for one session. Pure: no I/O, no clock. */
export function buildReviewPacket(input: ReviewPacketInput): ReviewPacket {
  const { detail, retrospective, activity, completion } = input;
  let redactions = 0;
  const quote = (text: string, max: number): string => {
    const quoted = quoteLineCounted(text, max);
    redactions += quoted.redactions;
    return quoted.line;
  };

  // Turn outcomes from the retrospective's own findings — never from text here.
  const corrected = new Set<number>();
  const interrupted = new Set<number>();
  for (const finding of retrospective.findings) {
    if (finding.turnIndex === undefined) {
      continue;
    }
    if (finding.id === 'correction-reprompt' && finding.turnIndex > 0) {
      corrected.add(finding.turnIndex - 1);
    } else if (finding.id === 'user-interruption') {
      interrupted.add(finding.turnIndex);
    }
  }
  const allTurns = detail.turns.map((turn, index) => {
    const outcome: PacketTurnOutcome = interrupted.has(index)
      ? 'interrupted'
      : !turn.success
        ? 'failed'
        : corrected.has(index)
          ? 'corrected'
          : 'ok';
    const text = turn.userRequest?.trim() ?? '';
    return {
      index,
      ...(text.length > 0 ? { line: quote(text, PACKET_TURN_LINE_MAX_CHARS) } : {}),
      outcome,
    };
  });

  let goal: ReviewPacket['goal'];
  if (retrospective.goal !== undefined && retrospective.goal.trim().length > 0) {
    goal = {
      text: quote(retrospective.goal, PACKET_GOAL_MAX_CHARS),
      fromPrompt: retrospective.goalSource === 'first-prompt',
    };
  }

  const allFiles = rollupFiles(activity.edits, input.toRepoPath);

  const byClass = new Map<CommandClass, { runs: number; failures: number }>();
  for (const command of activity.commands) {
    const entry = byClass.get(command.class) ?? { runs: 0, failures: 0 };
    entry.runs += 1;
    // A check's result comes from its observed outcome: agents routinely pipe
    // check output, so the exit status alone would miss most failures.
    const failed = isVerificationClass(command.class) ? commandOutcome(command) === 'failed' : command.failed;
    if (failed) {
      entry.failures += 1;
    }
    byClass.set(command.class, entry);
  }
  const commands = CLASS_ORDER.filter((cls) => byClass.has(cls)).map((cls) => ({
    class: cls,
    runs: byClass.get(cls)?.runs ?? 0,
    failures: byClass.get(cls)?.failures ?? 0,
  }));

  const verifying = activity.commands.filter((c) => isVerificationClass(c.class));
  const lastVerifying = verifying.length > 0 ? verifying[verifying.length - 1] : undefined;
  const verification: ReviewPacket['verification'] = {
    status: completion?.status ?? 'not-checked',
    testRuns: verifying.length,
    testFailures: verifying.filter((c) => commandOutcome(c) === 'failed').length,
    ...(lastVerifying !== undefined && commandOutcome(lastVerifying) !== 'unknown'
      ? { lastTestFailed: commandOutcome(lastVerifying) === 'failed' }
      : {}),
    checks: (completion?.checks ?? []).map((check) => ({ label: check.detail, passed: check.passed })),
  };

  const deadEnds: ReviewPacket['deadEnds'] = [];
  for (const finding of retrospective.findings) {
    const kind = DEAD_END_KINDS[finding.id];
    if (kind !== undefined && finding.turnIndex !== undefined && deadEnds.length < PACKET_MAX_DEAD_ENDS) {
      deadEnds.push({ turnIndex: finding.turnIndex, kind, note: finding.description });
    }
  }

  const riskHits = new Map<RiskId, { count: number; turnIndex?: number; quote?: string }>();
  const hit = (id: RiskId, turnIndex: number | undefined, text?: string): void => {
    const entry = riskHits.get(id);
    if (entry === undefined) {
      riskHits.set(id, {
        count: 1,
        ...(turnIndex !== undefined ? { turnIndex } : {}),
        ...(text !== undefined ? { quote: quote(text, PACKET_COMMAND_QUOTE_MAX_CHARS) } : {}),
      });
    } else {
      entry.count += 1;
    }
  };
  for (const command of activity.commands) {
    for (const id of detectCommandRisks(command.text)) {
      hit(id, command.turnIndex, command.text);
    }
  }
  for (const file of allFiles) {
    for (const id of detectPathRisks(file.path, file.insideRepo)) {
      hit(id, file.firstTurn);
    }
  }
  if (activity.permissionModes.some((mode) => isBypassPermissionMode(mode))) {
    hit('permission-bypass', undefined);
  }
  const allRisks = RISK_RULES.filter((rule) => riskHits.has(rule.id)).map((rule) => ({
    id: rule.id,
    label: rule.label,
    ...(riskHits.get(rule.id) as { count: number; turnIndex?: number; quote?: string }),
  }));

  const treeTokens = detail.agentUsage.reduce((sum, a) => sum + a.inputTokens + a.outputTokens, 0);
  const subAgents = activity.subAgents.map((agent) => {
    const tokens = detail.agentUsage
      .filter((a) => a.kind === 'subagent' && a.agentName === agent.name)
      .reduce((sum, a) => sum + a.inputTokens + a.outputTokens, 0);
    return {
      name: agent.name,
      calls: agent.calls,
      ...(treeTokens > 0 && tokens > 0 ? { tokenSharePct: Math.round((tokens / treeTokens) * 100) } : {}),
    };
  });

  return {
    source: detail.summary.source ?? 'unknown',
    sessionId: detail.summary.sessionId,
    repository: input.repository,
    ...(input.title !== undefined && input.title.trim().length > 0
      ? { title: quote(input.title, PACKET_TURN_LINE_MAX_CHARS) }
      : {}),
    ...(goal !== undefined ? { goal } : {}),
    turns: allTurns.slice(0, PACKET_MAX_TURNS),
    turnsOmitted: Math.max(0, allTurns.length - PACKET_MAX_TURNS),
    files: allFiles.slice(0, PACKET_MAX_FILES),
    filesOmitted: Math.max(0, allFiles.length - PACKET_MAX_FILES),
    filesAvailable: activity.complete,
    commands,
    verification,
    deadEnds,
    risks: allRisks.slice(0, PACKET_MAX_RISKS),
    risksOmitted: Math.max(0, allRisks.length - PACKET_MAX_RISKS),
    subAgents,
    models: detail.modelUsage.map((m) => ({
      model: m.model,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
    })),
    totals: {
      inputTokens: detail.treeStats.inputTokens,
      outputTokens: detail.treeStats.outputTokens,
      cachedTokens: detail.treeStats.cachedTokens,
      ...(detail.summary.costMicros !== undefined ? { costMicros: detail.summary.costMicros } : {}),
      durationMs: detail.summary.durationMs,
      turns: detail.turns.length,
    },
    costMode: input.costMode,
    verdict: retrospective.verdict,
    outcome: retrospective.outcome,
    findings: retrospective.findings.map((f) => ({ severity: f.severity, text: f.description })),
    tips: retrospective.tips.map((t) => t.text),
    redactions,
  };
}

interface Limits {
  turns: number;
  files: number;
  risks: number;
}

/**
 * Render one packet, or several as one document with a combined header.
 * Over the size cap the lists are trimmed in a fixed order — request lines,
 * then files, then risks — each ending in "and N more".
 */
export function renderReviewPacketMarkdown(
  packets: readonly ReviewPacket[],
  options: ReviewPacketOptions,
): string {
  if (packets.length === 0) {
    return '';
  }
  const cap = packets.length === 1 ? PACKET_MAX_CHARS : PACKET_MULTI_MAX_CHARS;
  const limits: Limits = { turns: PACKET_MAX_TURNS, files: PACKET_MAX_FILES, risks: PACKET_MAX_RISKS };
  let text = renderAll(packets, options, limits);
  const order: (keyof Limits)[] = ['turns', 'files', 'risks'];
  for (const key of order) {
    while (text.length > cap && limits[key] > 0) {
      limits[key] = Math.floor(limits[key] / 2);
      text = renderAll(packets, options, limits);
    }
  }
  return text.length > cap ? `${text.slice(0, cap - 1)}…` : text;
}

function renderAll(packets: readonly ReviewPacket[], options: ReviewPacketOptions, limits: Limits): string {
  const lines: string[] = [];
  if (packets.length === 1) {
    lines.push(...renderOne(packets[0], options, limits, 1));
  } else {
    const turns = packets.reduce((n, p) => n + p.totals.turns, 0);
    const tokens = packets.reduce((n, p) => n + p.totals.inputTokens + p.totals.outputTokens, 0);
    const priced = packets.filter((p) => p.totals.costMicros !== undefined);
    const cost = priced.reduce((n, p) => n + (p.totals.costMicros ?? 0), 0);
    const files = new Set(packets.flatMap((p) => p.files.map((f) => `${p.repository}/${f.path}`)));
    lines.push(`# Review packet: ${packets.length} sessions`, '');
    lines.push(
      `- ${packets.length} sessions, ${turns} requests, ${formatTokenCount(tokens)} tokens` +
        (priced.length > 0 ? `, est. cost ${formatUsd(cost)} (${priced.length} of ${packets.length} priced)` : ''),
    );
    lines.push(`- ${files.size} ${files.size === 1 ? 'file' : 'files'} changed across the sessions`, '');
    packets.forEach((packet, index) => {
      lines.push(...renderOne(packet, options, limits, 2, index + 1), '');
    });
  }
  const redactions = packets.reduce((n, p) => n + p.redactions, 0);
  lines.push('---');
  lines.push(
    "_Built on this machine from the session's own log, with no AI." +
      (redactions > 0
        ? ` ${redactions} secret-looking ${redactions === 1 ? 'string was' : 'strings were'} replaced.`
        : '') +
      ' Paths are relative to the repository; tool output is not included._',
  );
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

function renderOne(
  packet: ReviewPacket,
  options: ReviewPacketOptions,
  limits: Limits,
  level: number,
  ordinal?: number,
): string[] {
  const h = '#'.repeat(level);
  const sub = '#'.repeat(level + 1);
  const name = packet.title ?? packet.repository;
  const out: string[] = [];
  out.push(ordinal === undefined ? `${h} Review packet: ${name}` : `${h} Session ${ordinal}: ${name}`, '');
  out.push(`- Repository: ${packet.repository}`);
  out.push(
    `- ${packet.totals.turns} ${packet.totals.turns === 1 ? 'request' : 'requests'}, ` +
      `${formatDurationMs(packet.totals.durationMs)}, ` +
      `${formatTokenCount(packet.totals.inputTokens + packet.totals.outputTokens)} tokens` +
      (packet.totals.costMicros !== undefined
        ? `, est. cost ${formatUsd(packet.totals.costMicros)}${packet.costMode === 'usd' ? '' : ' (from billed units)'}`
        : ''),
  );
  out.push(`- How it went: ${verdictText(packet.verdict)}; outcome ${packet.outcome.replace(/-/g, ' ')}`, '');

  if (packet.goal !== undefined && (options.includePrompts || !packet.goal.fromPrompt)) {
    out.push(`${sub} Goal`, '', packet.goal.text, '');
  }

  out.push(`${sub} What was asked`, '');
  if (packet.turns.length === 0) {
    out.push('- (no requests recorded)');
  } else if (!options.includePrompts) {
    const count = (o: PacketTurnOutcome): number => packet.turns.filter((t) => t.outcome === o).length;
    out.push(
      `- ${packet.totals.turns} requests (prompt text not included): ${count('failed')} failed, ` +
        `${count('corrected')} corrected afterwards, ${count('interrupted')} interrupted`,
    );
  } else {
    const shown = packet.turns.slice(0, limits.turns);
    for (const turn of shown) {
      const suffix = turn.outcome === 'ok' ? '' : ` (${outcomeText(turn.outcome)})`;
      out.push(`${turn.index + 1}. ${turn.line ?? '(no text)'}${suffix}`);
    }
    const more = packet.turns.length - shown.length + packet.turnsOmitted;
    if (more > 0) {
      out.push(`- and ${more} more`);
    }
  }
  out.push('');

  out.push(`${sub} Files changed`, '');
  if (!packet.filesAvailable) {
    out.push('- File and command detail is not available for this source.');
  } else if (packet.files.length === 0) {
    out.push('- (no file edits recorded)');
  } else {
    const shown = packet.files.slice(0, limits.files);
    for (const file of shown) {
      out.push(
        `- ${file.path}${file.insideRepo ? '' : ' (outside the repository)'}: ` +
          `+${file.linesAdded} / -${file.linesRemoved}, ${file.edits} ${file.edits === 1 ? 'edit' : 'edits'}` +
          (file.reEdits > 0 ? `, re-edited ${file.reEdits} ${file.reEdits === 1 ? 'time' : 'times'}` : ''),
      );
    }
    const more = packet.files.length - shown.length + packet.filesOmitted;
    if (more > 0) {
      out.push(`- and ${more} more`);
    }
  }
  out.push('');

  if (packet.commands.length > 0) {
    out.push(`${sub} Commands`, '');
    for (const command of packet.commands) {
      out.push(
        `- ${command.class}: ${command.runs} ${command.runs === 1 ? 'run' : 'runs'}` +
          (command.failures > 0 ? `, ${command.failures} failed` : ''),
      );
    }
    out.push('');
  }

  out.push(`${sub} Verification`, '');
  if (packet.verification.status === 'not-checked') {
    out.push(
      `- Not checked by the completion check. ${packet.verification.testRuns} test, build, lint or type-check ` +
        `${packet.verification.testRuns === 1 ? 'run was' : 'runs were'} recorded` +
        (packet.verification.testFailures > 0 ? `, ${packet.verification.testFailures} failed` : '') +
        (packet.verification.lastTestFailed === true ? '; the last one failed' : '') +
        '.',
    );
  } else {
    out.push(`- Status: ${completionText(packet.verification.status)}`);
    for (const check of packet.verification.checks) {
      out.push(`- ${check.passed ? 'Observed' : 'Not observed'}: ${check.label}`);
    }
  }
  out.push('');

  if (packet.deadEnds.length > 0) {
    out.push(`${sub} Dead ends`, '');
    for (const deadEnd of packet.deadEnds) {
      out.push(`- Request ${deadEnd.turnIndex + 1}: ${deadEnd.note}`);
    }
    out.push('');
  }

  if (packet.risks.length > 0) {
    out.push(`${sub} Risky actions`, '');
    const shown = packet.risks.slice(0, limits.risks);
    for (const risk of shown) {
      out.push(
        `- ${risk.label}` +
          (risk.count > 1 ? ` (${risk.count} times)` : '') +
          (risk.turnIndex !== undefined ? `, first in request ${risk.turnIndex + 1}` : '') +
          (options.includePrompts && risk.quote !== undefined ? `: \`${risk.quote.replace(/`/g, "'")}\`` : ''),
      );
    }
    const more = packet.risks.length - shown.length + packet.risksOmitted;
    if (more > 0) {
      out.push(`- and ${more} more`);
    }
    out.push('');
  }

  if (packet.subAgents.length > 0) {
    out.push(`${sub} Sub-agents`, '');
    for (const agent of packet.subAgents) {
      out.push(
        `- ${agent.name}: ${agent.calls} ${agent.calls === 1 ? 'call' : 'calls'}` +
          (agent.tokenSharePct !== undefined ? `, about ${agent.tokenSharePct}% of the tokens` : ''),
      );
    }
    out.push('');
  }

  if (packet.models.length > 0) {
    out.push(`${sub} Models`, '');
    for (const model of packet.models) {
      out.push(`- ${model.model}: ${formatTokenCount(model.inputTokens)} in, ${formatTokenCount(model.outputTokens)} out`);
    }
    out.push('');
  }

  if (packet.findings.length > 0) {
    out.push(`${sub} Findings`, '');
    for (const finding of packet.findings) {
      out.push(`- ${finding.text}`);
    }
    out.push('');
  }
  if (packet.tips.length > 0) {
    out.push(`${sub} Suggestions`, '');
    for (const tip of packet.tips) {
      out.push(`- ${tip}`);
    }
    out.push('');
  }
  return out;
}

function verdictText(verdict: SessionVerdict): string {
  switch (verdict) {
    case 'smooth':
      return 'went smoothly';
    case 'bumpy':
      return 'some friction';
    case 'struggled':
      return 'struggled';
    case 'abandoned':
      return 'left unfinished';
  }
}

function outcomeText(outcome: PacketTurnOutcome): string {
  return outcome === 'corrected' ? 'corrected afterwards' : outcome;
}

function completionText(status: CompletionStatus): string {
  switch (status) {
    case 'verified':
      return 'verified (a check was seen to pass after the last edit)';
    case 'unverified':
      return 'not verified (no passing check was seen after the last edit)';
    case 'contradicted':
      return 'check failed (reported done, but the last check failed)';
    case 'incomplete':
      return 'left unfinished';
    case 'not-applicable':
      return 'not applicable (no code changes, or the source records no commands)';
  }
}

/** `950`, `12.3k`, `1.2M` — the same on every machine. */
export function formatTokenCount(value: number): string {
  if (value < 1000) {
    return String(Math.round(value));
  }
  if (value < 1_000_000) {
    return `${trimZero((value / 1000).toFixed(1))}k`;
  }
  return `${trimZero((value / 1_000_000).toFixed(1))}M`;
}

/** `under a minute`, `12 min`, `1 h 5 min`. */
export function formatDurationMs(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) {
    return 'under a minute';
  }
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

function trimZero(text: string): string {
  return text.endsWith('.0') ? text.slice(0, -2) : text;
}
