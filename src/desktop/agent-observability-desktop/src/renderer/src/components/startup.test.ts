import { describe, expect, it } from 'vitest';
import type { IndexStatus } from '../../../shared/rpc';
import { STAGE_NOTES, nextStartupStage, stageText, type StartupEvent, type StartupStage } from './startup';
import { FUN_NOTES } from './loadingNotes';

function progress(phase: IndexStatus['phase'], indexed = 0, total = 0): StartupEvent {
  return { kind: 'progress', status: { phase, indexed, total } };
}

function run(events: StartupEvent[], from: StartupStage = { kind: 'connecting' }): StartupStage {
  return events.reduce(nextStartupStage, from);
}

describe('nextStartupStage', () => {
  it('ignores the persisted idle the data host emits before the pass starts', () => {
    // This exact sequence dismissed the first version of the overlay at launch.
    expect(run([progress('idle', 120, 120)])).toEqual({ kind: 'connecting' });
  });

  it('walks the launch: discover, hydrate with counts, prepare on idle, done on warmed', () => {
    let stage = run([progress('idle'), progress('discovering')]);
    expect(stage).toEqual({ kind: 'discovering' });
    stage = nextStartupStage(stage, progress('hydrating', 40, 150));
    expect(stage).toEqual({ kind: 'hydrating', indexed: 40, total: 150 });
    stage = nextStartupStage(stage, progress('idle', 150, 150));
    // Not done yet: the queued view queries and the warm-up still drain.
    expect(stage).toEqual({ kind: 'preparing' });
    stage = nextStartupStage(stage, { kind: 'warmed' });
    expect(stage).toEqual({ kind: 'done' });
  });

  it('a warmed signal outside the preparing stage changes nothing', () => {
    expect(run([{ kind: 'warmed' }])).toEqual({ kind: 'connecting' });
  });

  it('an indexing error dismisses instead of trapping the user behind the overlay', () => {
    expect(run([progress('discovering'), progress('error')])).toEqual({ kind: 'done' });
  });

  it('a failed connection dismisses — the views explain a dead data host themselves', () => {
    expect(run([{ kind: 'connection', state: 'failed' }])).toEqual({ kind: 'done' });
  });

  it('the safety timeout dismisses from any stage', () => {
    expect(run([{ kind: 'timeout' }])).toEqual({ kind: 'done' });
    expect(run([progress('hydrating', 1, 9), { kind: 'timeout' }])).toEqual({ kind: 'done' });
  });

  it('once done, nothing brings the overlay back', () => {
    const done = run([progress('discovering'), progress('error')]);
    expect(nextStartupStage(done, progress('discovering'))).toEqual({ kind: 'done' });
    expect(nextStartupStage(done, { kind: 'connection', state: 'connecting' })).toEqual({
      kind: 'done',
    });
  });
});

describe('stageText', () => {
  it('names every stage and carries the hydration counts', () => {
    expect(stageText({ kind: 'connecting' }).stage).toBe('Starting the data service…');
    expect(stageText({ kind: 'discovering' }).stage).toBe('Finding your sessions on disk…');
    // Compared through the same formatter: the group separator is the
    // machine's locale ("1,200" here, "1 200" on a Swedish system).
    const hydrating = stageText({ kind: 'hydrating', indexed: 1200, total: 3400 });
    expect(hydrating.stage).toContain((1200).toLocaleString());
    expect(hydrating.stage).toContain((3400).toLocaleString());
    expect(stageText({ kind: 'preparing' }).stage).toBe('Preparing the session list and dashboard…');
  });

  it('rotates the note with the tick and wraps around', () => {
    const stage = { kind: 'hydrating', indexed: 1, total: 2 } as const;
    const first = stageText(stage, 0).note;
    const second = stageText(stage, 1).note;
    expect(second).not.toBe(first);
    // The cycle is the stage's own lines followed by the (shuffled) fun pool.
    expect(FUN_NOTES).toContain(stageText(stage, STAGE_NOTES.hydrating.length).note);
    expect(stageText(stage, STAGE_NOTES.hydrating.length + FUN_NOTES.length).note).toBe(first);
    // The headline never rotates — only the note under it does.
    expect(stageText(stage, 1).stage).toBe(stageText(stage, 0).stage);
  });

  it('opens every stage on its plain lead note — the jokes wait their turn', () => {
    // A fast pass shows only tick 0, so the lead line must stand alone as an
    // honest status; whimsy is reserved for rotations that had time to happen.
    expect(stageText({ kind: 'connecting' }, 0).note).toBe('First pass after a launch.');
    expect(stageText({ kind: 'preparing' }, 0).note).toBe(
      'Almost there — making the first click instant.',
    );
  });

  it('keeps the privacy line in every long rotation', () => {
    for (const notes of [STAGE_NOTES.discovering, STAGE_NOTES.hydrating]) {
      expect(notes).toContain('Everything is read locally — nothing is uploaded.');
    }
  });
});
