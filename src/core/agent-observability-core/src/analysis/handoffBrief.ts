import type { LiveLastEvent } from '../live/liveStatus';
import { quoteLineCounted } from '../text/redact';
import type { SessionDetail, SessionTurn } from '../telemetry/models';
import type { CompletionCheck } from './completionCheck';
import { isCorrectionPrompt, type SessionRetrospective } from './retrospective';
import {
  commandOutcome,
  isVerificationClass,
  rollupFiles,
  type RepoPathFn,
  type SessionActivity,
} from './sessionActivity';

/**
 * The hand-off brief: what the NEXT session needs to continue where this one
 * stopped, written to the next agent in the imperative. Goal, where things
 * stand, the constraints the user stated (in their own words), files in play,
 * what was and was not verified, open items, context files, a first prompt.
 *
 * Different from the review packet on purpose: the audience is an agent, so
 * there is no cost, token, verdict or tips section.
 *
 * Built locally with no AI. The same content rules as the packet apply:
 * every quoted string passes `quoteLineCounted` (redacted, one line, capped),
 * paths go through the injected {@link RepoPathFn}, and tool output is never
 * read — `SessionDetail` does not even carry it.
 */

export const HANDOFF_GOAL_MAX_CHARS = 600;
export const HANDOFF_MAX_CONSTRAINTS = 8;
export const HANDOFF_CONSTRAINT_MAX_CHARS = 400;
export const HANDOFF_LAST_REQUEST_MAX_CHARS = 600;
export const HANDOFF_MAX_FILES = 20;
export const HANDOFF_MAX_OPEN_ITEMS = 8;
export const HANDOFF_OPEN_ITEM_MAX_CHARS = 200;
export const HANDOFF_MAX_CONTEXT_FILES = 12;
export const HANDOFF_MAX_CHARS = 8000;
/** How much of one prompt or reply is scanned for markers. */
export const HANDOFF_SCAN_MAX_CHARS = 4000;

/** Words that mark a sentence in the user's prompt as a standing constraint. */
export const CONSTRAINT_MARKERS: readonly RegExp[] = [
  /\bmust(?:\s+not|n't)?\b/i,
  /\bnever\b/i,
  /\bdo\s+not\b/i,
  /\bdon't\b/i,
  /\balways\b/i,
  /\bonly\b/i,
  /\bwithout\b/i,
  /\binstead\s+of\b/i,
  /\bkeep\b/i,
  /\bavoid\b/i,
  /\bmake\s+sure\b/i,
];

/** Lines in the agent's last reply that read as unfinished work. */
export const OPEN_ITEM_MARKERS: readonly RegExp[] = [
  /\btodo\b/i,
  /\bnext\s+steps?\b/i,
  /\bremaining\b/i,
  /\bstill\s+need/i,
  /\bnot\s+yet\b/i,
  /^\s*[-*]\s*\[\s\]/,
  /\bfollow[- ]up\b/i,
];

export type HandoffEnding = 'turn-complete' | 'waiting' | 'interrupted' | 'error' | 'tool-pending' | 'unknown';

export interface HandoffBriefInput {
  detail: SessionDetail;
  retrospective: SessionRetrospective;
  activity: SessionActivity;
  completion?: CompletionCheck;
  /** Already repository-relative. */
  contextFiles: string[];
  /** From the live board, when the session is still on it. */
  liveLastEvent?: LiveLastEvent;
  lastToolFailed?: boolean;
  repository: string;
  toRepoPath: RepoPathFn;
}

export interface HandoffBrief {
  source: string;
  sessionId: string;
  repository: string;
  goal?: string;
  state: {
    turns: number;
    ending: HandoffEnding;
    lastRequest?: string;
    lastTurnFailed: boolean;
    filesChanged: number;
  };
  constraints: { turnIndex: number; text: string; kind: 'constraint' | 'correction' }[];
  files: { path: string; insideRepo: boolean; edits: number; lastTurn: number }[];
  verified: string[];
  notVerified: string[];
  openItems: { text: string; origin: 'last-reply' | 'failed-command' | 'interrupted' }[];
  contextFiles: string[];
  suggestedPrompt: string;
  redactions: number;
}

/** How the session ended: the live board's last event when known, else the transcript's shape. */
export function deriveEnding(
  input: Pick<HandoffBriefInput, 'detail' | 'retrospective' | 'liveLastEvent' | 'lastToolFailed'>,
): HandoffEnding {
  switch (input.liveLastEvent) {
    case 'tool-pending':
      return 'tool-pending';
    case 'interruption':
      return 'interrupted';
    case 'assistant-text':
      return 'waiting';
    case 'turn-ended':
      return 'turn-complete';
    case 'tool-result':
      if (input.lastToolFailed === true) {
        return 'error';
      }
      break;
    default:
      break;
  }
  const turns = input.detail.turns;
  if (turns.length === 0) {
    return 'unknown';
  }
  const lastIndex = turns.length - 1;
  const last = turns[lastIndex];
  if (input.retrospective.findings.some((f) => f.id === 'user-interruption' && f.turnIndex === lastIndex)) {
    return 'interrupted';
  }
  if (input.lastToolFailed === true || !last.success) {
    return 'error';
  }
  return (last.finalResponse ?? '').trim().length > 0 ? 'turn-complete' : 'unknown';
}

interface Counted<T> {
  value: T;
  redactions: number;
}

function constraintsCounted(turns: readonly SessionTurn[]): Counted<HandoffBrief['constraints']> {
  let redactions = 0;
  const found: HandoffBrief['constraints'] = [];
  const add = (turnIndex: number, raw: string, kind: 'constraint' | 'correction'): void => {
    const quoted = quoteLineCounted(raw, HANDOFF_CONSTRAINT_MAX_CHARS);
    redactions += quoted.redactions;
    if (quoted.line.length > 0) {
      found.push({ turnIndex, text: quoted.line, kind });
    }
  };
  turns.forEach((turn, turnIndex) => {
    const prompt = (turn.userRequest ?? '').slice(0, HANDOFF_SCAN_MAX_CHARS);
    if (prompt.trim().length === 0) {
      return;
    }
    const sentences = splitSentences(prompt);
    if (turnIndex > 0 && isCorrectionPrompt(prompt, true) && sentences.length > 0) {
      add(turnIndex, sentences[0], 'correction');
    }
    for (const sentence of sentences) {
      if (CONSTRAINT_MARKERS.some((marker) => marker.test(sentence))) {
        add(turnIndex, sentence, 'constraint');
      }
    }
  });
  // De-duplicate keeping the NEWEST statement of each, then keep the newest few, oldest first.
  const seen = new Set<string>();
  const unique: HandoffBrief['constraints'] = [];
  for (let i = found.length - 1; i >= 0; i -= 1) {
    const key = found[i].text.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.unshift(found[i]);
    }
  }
  return { value: unique.slice(-HANDOFF_MAX_CONSTRAINTS), redactions };
}

/**
 * Sentences in the user's own prompts that state a constraint, plus the
 * opening sentence of each correction. Verbatim (redacted, capped),
 * de-duplicated, newest last.
 */
export function extractConstraints(turns: readonly SessionTurn[]): HandoffBrief['constraints'] {
  return constraintsCounted(turns).value;
}

function openItemsCounted(lastResponse: string | undefined): Counted<string[]> {
  let redactions = 0;
  const items: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of (lastResponse ?? '').slice(-HANDOFF_SCAN_MAX_CHARS).split(/\r?\n/)) {
    if (items.length >= HANDOFF_MAX_OPEN_ITEMS) {
      break;
    }
    if (!OPEN_ITEM_MARKERS.some((marker) => marker.test(rawLine))) {
      continue;
    }
    const stripped = rawLine.replace(/^\s*(?:[-*•]|\d+[.)])\s*(?:\[\s?\]\s*)?/, '').replace(/^#+\s*/, '');
    const quoted = quoteLineCounted(stripped, HANDOFF_OPEN_ITEM_MAX_CHARS);
    redactions += quoted.redactions;
    const key = quoted.line.toLowerCase();
    if (quoted.line.length > 0 && !seen.has(key)) {
      seen.add(key);
      items.push(quoted.line);
    }
  }
  return { value: items, redactions };
}

/** Lines of the agent's LAST reply that read as unfinished work. May be wrong: they are the agent's own words. */
export function extractOpenItems(lastResponse: string | undefined): string[] {
  return openItemsCounted(lastResponse).value;
}

/** Build the structured brief for one session. Pure: no I/O, no clock. */
export function buildHandoffBrief(input: HandoffBriefInput): HandoffBrief {
  const { detail, retrospective, activity, completion } = input;
  let redactions = 0;
  const quote = (text: string, max: number): string => {
    const quoted = quoteLineCounted(text, max);
    redactions += quoted.redactions;
    return quoted.line;
  };

  const turns = detail.turns;
  const last = turns.length > 0 ? turns[turns.length - 1] : undefined;
  const ending = deriveEnding(input);

  const constraints = constraintsCounted(turns);
  redactions += constraints.redactions;

  const rolled = rollupFiles(activity.edits, input.toRepoPath);
  const files = [...rolled]
    .sort((a, b) => b.lastTurn - a.lastTurn || b.edits - a.edits || a.path.localeCompare(b.path))
    .slice(0, HANDOFF_MAX_FILES)
    .map((f) => ({ path: f.path, insideRepo: f.insideRepo, edits: f.edits, lastTurn: f.lastTurn }));

  const verified: string[] = [];
  const notVerified: string[] = [];
  const verifying = activity.commands.filter((c) => isVerificationClass(c.class));
  const lastVerifying = verifying.length > 0 ? verifying[verifying.length - 1] : undefined;
  if (completion !== undefined && completion.status !== 'not-applicable') {
    for (const check of completion.checks) {
      (check.passed ? verified : notVerified).push(check.detail);
    }
  } else if (lastVerifying === undefined) {
    notVerified.push('No test, build, lint or type-check run was recorded in the session.');
  } else if (commandOutcome(lastVerifying) === 'passed') {
    verified.push(`The last ${lastVerifying.class} run was observed to pass (request ${lastVerifying.turnIndex + 1}).`);
  } else {
    notVerified.push(`The last ${lastVerifying.class} run did not show a passing result.`);
  }

  const openItems: HandoffBrief['openItems'] = [];
  if (lastVerifying !== undefined && commandOutcome(lastVerifying) === 'failed') {
    openItems.push({ text: `The last ${lastVerifying.class} run failed.`, origin: 'failed-command' });
  }
  if (ending === 'interrupted') {
    openItems.push({ text: 'The last request was interrupted before it finished.', origin: 'interrupted' });
  }
  const fromReply = openItemsCounted(last?.finalResponse);
  redactions += fromReply.redactions;
  for (const text of fromReply.value) {
    if (openItems.length < HANDOFF_MAX_OPEN_ITEMS) {
      openItems.push({ text, origin: 'last-reply' });
    }
  }

  const goal =
    retrospective.goal !== undefined && retrospective.goal.trim().length > 0
      ? quote(retrospective.goal, HANDOFF_GOAL_MAX_CHARS)
      : undefined;
  const lastRequest =
    last?.userRequest !== undefined && last.userRequest.trim().length > 0
      ? quote(last.userRequest, HANDOFF_LAST_REQUEST_MAX_CHARS)
      : undefined;

  const brief: HandoffBrief = {
    source: detail.summary.source ?? 'unknown',
    sessionId: detail.summary.sessionId,
    repository: input.repository,
    ...(goal !== undefined ? { goal } : {}),
    state: {
      turns: turns.length,
      ending,
      ...(lastRequest !== undefined ? { lastRequest } : {}),
      lastTurnFailed: last !== undefined && !last.success,
      filesChanged: rolled.length,
    },
    constraints: constraints.value,
    files,
    verified,
    notVerified,
    openItems,
    contextFiles: input.contextFiles.slice(0, HANDOFF_MAX_CONTEXT_FILES),
    suggestedPrompt: '',
    redactions,
  };
  brief.suggestedPrompt = suggestPrompt(brief);
  return brief;
}

function suggestPrompt(brief: HandoffBrief): string {
  const parts: string[] = [];
  parts.push(
    brief.goal !== undefined
      ? `Continue this work: ${brief.goal}`
      : 'Continue the work described in this brief.',
  );
  const top = brief.files.slice(0, 3).map((f) => f.path);
  if (top.length > 0) {
    parts.push(`Read ${top.join(', ')} first.`);
  }
  if (brief.openItems.length > 0) {
    parts.push(`Start with this open item: ${brief.openItems[0].text}`);
  }
  if (brief.constraints.length > 0) {
    parts.push('Respect the constraints listed above.');
  }
  parts.push(
    brief.verified.length > 0
      ? 'Do not redo what is listed as verified; run the project checks before you report back.'
      : 'Nothing is verified yet; run the project checks before you report back.',
  );
  return parts.join(' ');
}

const ENDING_TEXT: Readonly<Record<HandoffEnding, string>> = {
  'turn-complete': 'The last request was answered and the session stopped there.',
  waiting: 'The agent had answered and was waiting for the next instruction.',
  interrupted: 'The last request was interrupted before it finished.',
  error: 'The session ended on a failed step.',
  'tool-pending': 'A tool call was still pending when the session stopped; it may not have completed.',
  unknown: 'How the session ended could not be determined.',
};

/** The brief as Markdown, to paste as the first message of a new session. */
export function renderHandoffBriefMarkdown(brief: HandoffBrief): string {
  let files = brief.files.length;
  let constraints = brief.constraints.length;
  let text = render(brief, files, constraints);
  while (text.length > HANDOFF_MAX_CHARS && files > 0) {
    files = Math.floor(files / 2);
    text = render(brief, files, constraints);
  }
  while (text.length > HANDOFF_MAX_CHARS && constraints > 0) {
    constraints = Math.floor(constraints / 2);
    text = render(brief, files, constraints);
  }
  return text.length > HANDOFF_MAX_CHARS ? `${text.slice(0, HANDOFF_MAX_CHARS - 1)}…` : text;
}

function render(brief: HandoffBrief, fileLimit: number, constraintLimit: number): string {
  const out: string[] = [];
  out.push('# Hand-off brief', '');
  out.push(
    `You are continuing earlier work in ${brief.repository}. Read this brief first, then follow the suggested first prompt at the end.`,
    '',
  );

  out.push('## Goal', '', brief.goal ?? '(no goal was recorded; ask before assuming one)', '');

  out.push('## Where things stand', '');
  out.push(`- ${brief.state.turns} ${brief.state.turns === 1 ? 'request has' : 'requests have'} been handled so far.`);
  out.push(`- ${ENDING_TEXT[brief.state.ending]}`);
  if (brief.state.lastTurnFailed) {
    out.push('- The last request did not complete successfully.');
  }
  if (brief.state.lastRequest !== undefined) {
    out.push(`- The last request was: "${brief.state.lastRequest}"`);
  }
  out.push(`- ${brief.state.filesChanged} ${brief.state.filesChanged === 1 ? 'file has' : 'files have'} been changed.`, '');

  out.push('## Constraints I was given', '');
  if (brief.constraints.length === 0) {
    out.push('- (none were stated explicitly)');
  } else {
    // The newest are kept when the list has to shrink.
    for (const constraint of brief.constraints.slice(brief.constraints.length - constraintLimit)) {
      const label = constraint.kind === 'correction' ? 'correction, ' : '';
      out.push(`- "${constraint.text}" (${label}request ${constraint.turnIndex + 1})`);
    }
    if (constraintLimit < brief.constraints.length) {
      out.push(`- and ${brief.constraints.length - constraintLimit} earlier ones`);
    }
  }
  out.push('');

  out.push('## Files in play', '');
  if (brief.files.length === 0) {
    out.push('- (no file edits were recorded)');
  } else {
    for (const file of brief.files.slice(0, fileLimit)) {
      out.push(
        `- ${file.path}${file.insideRepo ? '' : ' (outside the repository)'}: ` +
          `${file.edits} ${file.edits === 1 ? 'edit' : 'edits'}, last touched in request ${file.lastTurn + 1}`,
      );
    }
    if (fileLimit < brief.files.length) {
      out.push(`- and ${brief.files.length - fileLimit} more`);
    }
  }
  out.push('');

  out.push('## Verified and not verified', '');
  for (const line of brief.verified) {
    out.push(`- Verified: ${line}`);
  }
  for (const line of brief.notVerified) {
    out.push(`- Not verified: ${line}`);
  }
  if (brief.verified.length === 0 && brief.notVerified.length === 0) {
    out.push('- Nothing was recorded either way; treat the work as not verified.');
  }
  out.push('');

  out.push('## Open items', '');
  if (brief.openItems.length === 0) {
    out.push('- (none detected)');
  } else {
    for (const item of brief.openItems) {
      out.push(`- ${item.text}${item.origin === 'last-reply' ? ' (from the last reply)' : ''}`);
    }
  }
  out.push('');

  if (brief.contextFiles.length > 0) {
    out.push('## Context files loaded', '');
    for (const file of brief.contextFiles) {
      out.push(`- ${file}`);
    }
    out.push('');
  }

  out.push('## Suggested first prompt', '', brief.suggestedPrompt, '');
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Split prose into sentences on terminal punctuation and line breaks. */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\r?\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
