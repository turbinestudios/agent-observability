import type { SessionTurn } from '../../telemetry/models';
import { isCommandText, isInterruptionText } from '../../analysis/retrospective';

/**
 * The per-turn transcript digest shared by the Deep Retrospective and the AI
 * Helper's focus-session grounding.
 *
 * PRIVACY: the returned lines CONTAIN raw session content — the developer's
 * prompts and the assistant's final responses, capped per turn. Anything built
 * on this may only ever reach a model through one of the sanctioned, gated
 * exceptions in AGENTS.md's privacy invariant. Callers own those gates; this
 * module only formats text.
 */

/** How much of a transcript a digest may carry. */
export interface DigestCaps {
  /** Per-turn cap on the developer's prompt. */
  promptChars: number;
  /** Per-turn cap on the assistant's final response. */
  responseChars: number;
  /** Sessions longer than this send the opening turns plus the most recent ones. */
  maxTurns: number;
  /** How many opening turns survive the sampling. */
  headTurns: number;
}

/** The caps the Deep Retrospective ships with — the only budget proven against the real CLI. */
export const DEEP_RETRO_CAPS: DigestCaps = {
  promptChars: 1500,
  responseChars: 1000,
  maxTurns: 30,
  headTurns: 10,
};

/** The per-turn digest, head-and-tail-sampled for very long sessions. */
export function buildTranscriptDigest(turns: readonly SessionTurn[], caps: DigestCaps): string[] {
  const indexed = turns.map((turn, index) => ({ turn, index }));
  let sampled = indexed;
  let omitted = 0;
  if (indexed.length > caps.maxTurns) {
    omitted = indexed.length - caps.maxTurns;
    sampled = [
      ...indexed.slice(0, caps.headTurns),
      ...indexed.slice(indexed.length - (caps.maxTurns - caps.headTurns)),
    ];
  }

  const lines: string[] = [];
  let lastIndex = -1;
  for (const { turn, index } of sampled) {
    if (lastIndex >= 0 && index !== lastIndex + 1) {
      lines.push('', `(… ${omitted} middle turns omitted …)`);
    }
    lastIndex = index;
    lines.push('', `## Turn ${index + 1}`);
    const request = turn.userRequest;
    if (request !== undefined && isInterruptionText(request)) {
      lines.push('The developer interrupted the agent here.');
      continue;
    }
    if (request !== undefined && isCommandText(request)) {
      lines.push('(slash-command bookkeeping)');
      continue;
    }
    if (request !== undefined) {
      lines.push(`Developer asked: ${cap(request, caps.promptChars)}`);
    }
    const tools = toolSummary(turn);
    if (tools !== undefined) {
      lines.push(`Tools: ${tools}`);
    }
    if (turn.finalResponse !== undefined) {
      lines.push(`Assistant finished: ${cap(turn.finalResponse, caps.responseChars)}`);
    }
    if (turn.linesOfCode + turn.linesOfCodeRemoved > 0) {
      lines.push(`Code lines: +${turn.linesOfCode} / -${turn.linesOfCodeRemoved}`);
    }
  }
  return lines;
}

/** `Read ×3, Edit ×2, Bash ✗×1` — names and failure counts, nothing more. */
function toolSummary(turn: SessionTurn): string | undefined {
  const counts = new Map<string, { ok: number; failed: number }>();
  for (const event of turn.events) {
    if (event.operation !== 'execute_tool') {
      continue;
    }
    const name = event.toolName ?? 'tool';
    const entry = counts.get(name) ?? { ok: 0, failed: 0 };
    if (event.success) {
      entry.ok++;
    } else {
      entry.failed++;
    }
    counts.set(name, entry);
  }
  if (counts.size === 0) {
    return undefined;
  }
  return [...counts.entries()]
    .map(([name, c]) => {
      const parts: string[] = [];
      if (c.ok > 0) {
        parts.push(`×${c.ok}`);
      }
      if (c.failed > 0) {
        parts.push(`failed ×${c.failed}`);
      }
      return `${name} ${parts.join(', ')}`;
    })
    .join('; ');
}

function cap(text: string, max: number): string {
  const flat = text.trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
