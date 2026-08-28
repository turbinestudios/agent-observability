import type { SessionDetail } from '../../telemetry/models';
import {
  type RetrospectiveLlmVerdict,
  type SessionOutcome,
  type SessionRetrospective,
} from '../../analysis/retrospective';
import { extractFencedBlock } from './fenced';
import { buildTranscriptDigest, DEEP_RETRO_CAPS } from './transcriptDigest';

/**
 * The Deep Retrospective task: ask the user's own Claude Code CLI to judge one
 * session — was the goal fulfilled, how did the run go, was the opening prompt
 * good — grounded in a digest of the transcript plus the heuristic engine's
 * findings.
 *
 * PRIVACY BOUNDARY — A SANCTIONED EXCEPTION. Unlike `logSummary.ts` (safe
 * metadata only), the prompt built here CONTAINS raw session content: the
 * user's prompts and the assistant's final responses, capped per turn (the
 * digest itself lives in `transcriptDigest.ts`). Sending it to the CLI
 * transmits that content to Anthropic under the user's own Claude login. That
 * is permitted ONLY behind the double consent gate documented in AGENTS.md and
 * docs/proposals/09-session-retrospective.md — a default-off setting plus a
 * per-invocation confirmation naming exactly what is sent. Callers own that
 * gate; this module only builds and parses text. Nothing here may ever run in
 * the background or feed the aggregate/sync path.
 *
 * Prompt-building and parsing are pure so they are fully unit-testable; the
 * spawn lives with the host (the desktop datahost).
 */

/** Fence tag the model must put its JSON verdict in. */
export const DEEP_RETRO_FENCE = 'ao-retro';

/** Per-turn caps keep the digest inside a sane context budget (see `transcriptDigest.ts`). */
export const DEEP_RETRO_PROMPT_CHARS = DEEP_RETRO_CAPS.promptChars;
export const DEEP_RETRO_RESPONSE_CHARS = DEEP_RETRO_CAPS.responseChars;
/** Sessions longer than this send the opening turns plus the most recent ones. */
export const DEEP_RETRO_MAX_TURNS = DEEP_RETRO_CAPS.maxTurns;

const VALID_OUTCOMES: readonly SessionOutcome[] = [
  'likely-fulfilled',
  'partially',
  'unclear',
  'likely-unfulfilled',
];

/** Build the judging prompt. See the header: the result carries raw content. */
export function buildDeepRetrospectivePrompt(
  detail: SessionDetail,
  heuristic: SessionRetrospective,
): string {
  const lines: string[] = [];
  lines.push(
    'You are reviewing one finished coding-agent session for the developer who ran it.',
    'Judge it against their intent: what was the goal, does the transcript show it was',
    'reached, where was the friction, and how could the opening prompt have been better.',
    'Be direct and concrete; address the setup and the prompts, never the developer.',
    '',
    `Stated goal: ${heuristic.goal ?? '(none recorded)'}`,
    `A heuristic pass judged this session "${heuristic.verdict}" (${heuristic.outcome}).`,
  );
  if (heuristic.findings.length > 0) {
    lines.push('Heuristic findings:');
    for (const finding of heuristic.findings) {
      const where = finding.turnIndex !== undefined ? ` (turn ${finding.turnIndex + 1})` : '';
      lines.push(`- ${finding.id}${where}: ${finding.description}`);
    }
  }
  lines.push('', '# Transcript digest', ...buildTranscriptDigest(detail.turns, DEEP_RETRO_CAPS));
  lines.push(
    '',
    '# Answer format',
    `Reply with exactly one fenced code block tagged \`${DEEP_RETRO_FENCE}\` containing JSON:`,
    '```' + DEEP_RETRO_FENCE,
    '{',
    '  "goal": "the goal in one sentence, as the transcript reveals it",',
    '  "outcome": "likely-fulfilled" | "partially" | "unclear" | "likely-unfulfilled",',
    '  "narrative": "how the session actually went, at most 120 words",',
    '  "promptCritique": "what the opening prompt did well or lacked, at most 80 words",',
    '  "advice": ["at most three concrete suggestions for next time"]',
    '}',
    '```',
    'No text outside the fenced block.',
  );
  return lines.join('\n');
}

/**
 * Parse the model's reply into a verdict. Tolerant: a missing fence, invalid
 * JSON, or wrong field types yield `undefined` (the host reports "no verdict")
 * rather than a partial object pretending to be one.
 */
export function parseDeepRetrospective(
  text: string,
  model: string,
  generatedAtMs: number,
): RetrospectiveLlmVerdict | undefined {
  const body = extractFencedBlock(text, [DEEP_RETRO_FENCE]);
  if (body === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const verdict: RetrospectiveLlmVerdict = { model, generatedAtMs };
  if (typeof record.goal === 'string' && record.goal.trim().length > 0) {
    verdict.goal = record.goal.trim();
  }
  if (typeof record.outcome === 'string' && (VALID_OUTCOMES as readonly string[]).includes(record.outcome)) {
    verdict.outcome = record.outcome as SessionOutcome;
  }
  if (typeof record.narrative === 'string' && record.narrative.trim().length > 0) {
    verdict.narrative = record.narrative.trim();
  }
  if (typeof record.promptCritique === 'string' && record.promptCritique.trim().length > 0) {
    verdict.promptCritique = record.promptCritique.trim();
  }
  if (Array.isArray(record.advice)) {
    const advice = record.advice.filter((a): a is string => typeof a === 'string' && a.trim().length > 0).map((a) => a.trim()).slice(0, 3);
    if (advice.length > 0) {
      verdict.advice = advice;
    }
  }
  // A verdict that parsed but says nothing is no verdict.
  if (verdict.narrative === undefined && verdict.outcome === undefined && verdict.advice === undefined) {
    return undefined;
  }
  return verdict;
}
