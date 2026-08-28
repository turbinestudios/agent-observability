import type { IndexStatus } from '../../../shared/rpc';
import { rotatedNote } from './loadingNotes';

/**
 * The startup overlay's state machine, split from the component so it tests in
 * this package's node-only vitest setup (the component imports the data-host
 * client, which touches `window` at module load).
 *
 * Why a machine at all: the data host's startup chatter is easy to misread.
 * On attach it first emits `index.progress` with the PERSISTED status — whose
 * phase is `idle` — and only then schedules the real index pass. The first
 * version of the overlay took that idle for "startup finished" and dismissed
 * before the pass had begun, which is exactly the dead-window experience it
 * existed to prevent. Encoding "idle only counts after a non-idle phase" here,
 * where a test can pin it, keeps that from regressing.
 */

export type StartupStage =
  | { kind: 'connecting' }
  | { kind: 'discovering' }
  | { kind: 'hydrating'; indexed: number; total: number }
  /** Index settled; the queued view queries and the warm-up barrier drain. */
  | { kind: 'preparing' }
  | { kind: 'done' };

export type StartupEvent =
  | { kind: 'connection'; state: 'connecting' | 'connected' | 'failed' }
  | { kind: 'progress'; status: IndexStatus }
  /** The warm-up barrier resolved: list and dashboard queries are answered. */
  | { kind: 'warmed' }
  /** The overall safety cap fired — nobody gets locked out by a wedge. */
  | { kind: 'timeout' };

export function nextStartupStage(current: StartupStage, event: StartupEvent): StartupStage {
  // Done is terminal: the overlay never returns for a later manual refresh,
  // which runs behind a live, populated UI.
  if (current.kind === 'done') {
    return current;
  }
  if (event.kind === 'timeout') {
    return { kind: 'done' };
  }
  if (event.kind === 'connection') {
    // The views render their own dead-host explanation; trapping the user
    // behind an overlay would only hide it.
    return event.state === 'failed' ? { kind: 'done' } : current;
  }
  if (event.kind === 'warmed') {
    return current.kind === 'preparing' ? { kind: 'done' } : current;
  }

  const { status } = event;
  switch (status.phase) {
    case 'discovering':
      return { kind: 'discovering' };
    case 'hydrating':
      return { kind: 'hydrating', indexed: status.indexed, total: status.total };
    case 'error':
      // The Sessions status bar carries the message from here.
      return { kind: 'done' };
    case 'idle':
      // The persisted status emitted on attach is idle BEFORE the pass starts;
      // only an idle that follows a non-idle phase means the pass settled.
      return current.kind === 'discovering' || current.kind === 'hydrating'
        ? { kind: 'preparing' }
        : current;
  }
}

/** What the card says per stage. */
/**
 * Stage-specific note lines. A long pass with one frozen line under the
 * spinner reads as a hang; each stage rotates through these and then drifts
 * into the shared `FUN_NOTES` pool (see `./loadingNotes.ts`), so a slow start
 * has plenty of variety. Order matters twice over: the FIRST line of each
 * stage is the plain one a fast pass will show alone (the jokes only appear
 * once there has been time to earn them), and the privacy line stays in every
 * long rotation because it is the one fact worth repeating. Exported so tests
 * derive cycle lengths instead of hard-coding them.
 */
export const STAGE_NOTES: Record<Exclude<StartupStage, { kind: 'done' }>['kind'], readonly string[]> = {
  connecting: [
    'First pass after a launch.',
    'The data service runs in its own process, off the UI thread.',
    'Booting the datahost. It also just woke up.',
  ],
  discovering: [
    'First pass after a launch.',
    'Scanning the Claude Code and Copilot session stores.',
    'Spelunking through ~/.claude for forgotten sessions…',
    'Counting your late-night sessions. No judgement.',
    'Everything is read locally — nothing is uploaded.',
  ],
  hydrating: [
    'The list fills in as sessions are read.',
    'Each transcript is parsed once, then cached in the local index.',
    'Reticulating transcripts…',
    'Tokenizing the tokens that counted your tokens.',
    'Everything is read locally — nothing is uploaded.',
    'Reliving your finest prompts. And the other ones.',
    'Long transcripts take the longest — the count keeps moving.',
  ],
  preparing: [
    'Almost there — making the first click instant.',
    'Warming the session list and dashboard queries.',
    'Pre-warming SQLite. It likes that.',
  ],
};

/**
 * What the card says per stage. `tick` cycles the note line — the component
 * advances it on a timer so long stages stay visibly alive — through the
 * stage's own lines first, then the shared pool in `seed`'s shuffle order.
 */
export function stageText(
  stage: Exclude<StartupStage, { kind: 'done' }>,
  tick = 0,
  seed = 0,
): {
  stage: string;
  note: string;
} {
  const note = rotatedNote(STAGE_NOTES[stage.kind], tick, seed);
  switch (stage.kind) {
    case 'connecting':
      return { stage: 'Starting the data service…', note };
    case 'discovering':
      return { stage: 'Finding your sessions on disk…', note };
    case 'hydrating':
      return {
        stage: `Reading sessions — ${stage.indexed.toLocaleString()} of ${stage.total.toLocaleString()}…`,
        note,
      };
    case 'preparing':
      return { stage: 'Preparing the session list and dashboard…', note };
  }
}
