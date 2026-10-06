import type { RunPrefill } from '../../shared/runTypes';

/**
 * The doors into Run. Each turns something the app already computed into the
 * starting text of an EDITABLE goal box. Nothing here sends anything: the
 * user reads the text, changes it, and only then presses Start, and what is
 * in the box at that moment is exactly what is sent.
 *
 * Pure: every builder takes plain strings and arrays, so it depends on no
 * datahost state and the caller decides what to pass in. Every result is
 * capped, so a long digest or brief cannot produce a goal too large to send.
 */

export const PREFILL_MAX_CHARS = 12_000;
export const PREFILL_MAX_LIST_ITEMS = 12;
const TRUNCATED = '\n\n[Shortened to fit. The full text is in the app.]';

export function capPrefill(text: string, max: number = PREFILL_MAX_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return trimmed.slice(0, Math.max(0, max - TRUNCATED.length)).trimEnd() + TRUNCATED;
}

/** "Continue this session": resumes it; the box starts empty for the next instruction. */
export function continueSessionPrefill(sessionId: string, repository: string | undefined): RunPrefill {
  return {
    door: 'continue-session',
    goal: '',
    ...(repository !== undefined ? { repository } : {}),
    resumeSessionId: sessionId,
  };
}

/** "Start a session with this digest", from a repository hub. */
export function digestPrefill(repository: string, digestMarkdown: string): RunPrefill {
  const goal =
    'Here is what earlier agent sessions in this repository learned. Read it, then tell me which of these ' +
    'points you would act on first and why, before changing anything.\n\n' +
    digestMarkdown;
  return { door: 'repo-digest', goal: capPrefill(goal), repository };
}

/** "Apply this plan with an agent", from Improve. Paths are repository-relative. */
export function planPrefill(
  repository: string,
  summary: string | undefined,
  edits: readonly { path: string; action: string; rationale?: string }[],
): RunPrefill {
  const lines = edits.slice(0, PREFILL_MAX_LIST_ITEMS).map((edit) => {
    const why = edit.rationale !== undefined && edit.rationale.trim().length > 0 ? `: ${edit.rationale.trim()}` : '';
    return `- ${edit.action} \`${edit.path}\`${why}`;
  });
  if (edits.length > PREFILL_MAX_LIST_ITEMS) {
    lines.push(`- and ${edits.length - PREFILL_MAX_LIST_ITEMS} more`);
  }
  const goal = [
    "Improve this repository's context files as described below. Show me each change before you write it.",
    summary !== undefined && summary.trim().length > 0 ? summary.trim() : undefined,
    lines.length > 0 ? `Proposed changes:\n${lines.join('\n')}` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join('\n\n');
  return { door: 'improve-plan', goal: capPrefill(goal), repository };
}

/**
 * "Retry with the retrospective's advice". Takes the retrospective's own
 * generic sentences (findings and tips), never transcript text.
 */
export function retroPrefill(
  repository: string | undefined,
  goal: string | undefined,
  tips: readonly string[],
  findings: readonly string[],
): RunPrefill {
  const list = (title: string, items: readonly string[]): string | undefined =>
    items.length === 0
      ? undefined
      : `${title}\n${items
          .slice(0, PREFILL_MAX_LIST_ITEMS)
          .map((item) => `- ${item.trim()}`)
          .join('\n')}`;
  const text = [
    goal !== undefined && goal.trim().length > 0 ? `Goal: ${goal.trim()}` : 'Goal: (describe what you want done)',
    list('An earlier attempt at this ran into:', findings),
    list('This time:', tips),
    'Run the project checks before you report back, and say which ones you ran.',
  ]
    .filter((part): part is string => part !== undefined)
    .join('\n\n');
  return { door: 'retro-advice', goal: capPrefill(text), ...(repository !== undefined ? { repository } : {}) };
}

/** A hand-off brief becomes the first message of the next session, verbatim. */
export function handoffPrefill(repository: string | undefined, briefMarkdown: string): RunPrefill {
  return { door: 'handoff-brief', goal: capPrefill(briefMarkdown), ...(repository !== undefined ? { repository } : {}) };
}

export function blankPrefill(repository?: string): RunPrefill {
  return { door: 'blank', goal: '', ...(repository !== undefined ? { repository } : {}) };
}
