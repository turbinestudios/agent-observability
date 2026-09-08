import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { dataHost } from '../api/client';
import { PAGE_SIZE } from '../views/sessions/useSessions';
import { readStoredWindow } from '../views/overview/window';
import { Spinner } from './Spinner';
import { nextStartupStage, stageText, type StartupStage } from './startup';
import { useNoteTick } from './useNoteTick';

/**
 * A short readiness overlay: once connected, query the saved index and dismiss.
 * Background indexing/analysis has its own worker and must never gate browsing.
 * On a first install the list fills progressively rather than locking navigation
 * until every transcript has been parsed. The state machine ignores background
 * progress once these interactive readiness queries are in flight.
 *
 * `suppressed` lets the shell stand it down while something more important
 * owns the window — today an app upgrade the user consented to, which retires
 * this overlay for the rest of the session (see the shell's overlay comment).
 * The machine keeps running while suppressed, so the warm-up still happens.
 */

/** Nobody gets locked behind a wedge: the overlay always lifts eventually. */
const STARTUP_CAP_MS = 120_000;

export function StartupOverlay({
  suppressed = false,
  onDone,
}: {
  suppressed?: boolean;
  /**
   * Fired once when the stage machine reaches 'done' — the shell's signal that
  * startup surfaces may now appear. Background progress cannot reopen it.
   */
  onDone?: () => void;
}): JSX.Element | null {
  const [stage, setStage] = useState<StartupStage>(() =>
    dataHost.connectionState() === 'failed' ? { kind: 'done' }
      : dataHost.connectionState() === 'connected' ? { kind: 'preparing' } : { kind: 'connecting' },
  );
  // The rotating note restarts on each stage, so it always opens on the
  // stage's honest lead line before drifting into the fun pool, whose order
  // the seed reshuffles per stage.
  const note = useNoteTick(stage.kind, stage.kind !== 'done');
  // The barrier must fire exactly once, however many progress events arrive.
  const warmingRef = useRef(false);
  // So must onDone — 'done' is terminal, but effects re-run on other deps.
  const doneRef = useRef(false);

  useEffect(() => {
    if (stage.kind === 'done' && !doneRef.current) {
      doneRef.current = true;
      onDone?.();
    }
  }, [stage.kind, onDone]);

  useEffect(() => {
    const offConnection = dataHost.onConnectionChange((state) => {
      setStage((current) => nextStartupStage(current, { kind: 'connection', state }));
    });
    setStage((current) => nextStartupStage(current, { kind: 'connection', state: dataHost.connectionState() }));
    const offProgress = dataHost.on('index.progress', (event) => {
      if (event.event !== 'index.progress') {
        return;
      }
      setStage((current) => nextStartupStage(current, { kind: 'progress', status: event.status }));
    });
    const cap = setTimeout(
      () => setStage((current) => nextStartupStage(current, { kind: 'timeout' })),
      STARTUP_CAP_MS,
    );
    return () => {
      offConnection();
      offProgress();
      clearTimeout(cap);
    };
  }, []);

  useEffect(() => {
    if (stage.kind !== 'preparing' || warmingRef.current) {
      return;
    }
    warmingRef.current = true;
    // The same queries the views mount with — identical page, identical SQL —
    // so this both orders after them (FIFO barrier) and warms their caches.
    // allSettled, not all: a failing warm-up must dismiss the overlay, not
    // freeze it; the views render their own errors.
    void Promise.allSettled([
      dataHost.call('sessions.list', { limit: PAGE_SIZE }),
      // The window the Dashboard will actually open on — warming a different
      // one would order correctly but leave the query the view issues cold.
      dataHost.call('overview.get', { window: readStoredWindow() }),
      dataHost.call('overview.insights', { window: readStoredWindow() }),
    ]).then(() => setStage((current) => nextStartupStage(current, { kind: 'warmed' })));
  }, [stage.kind]);

  // Below the hooks, never above them: while suppressed the stage machine must
  // keep advancing, or the overlay would return stuck on a stage the app left
  // minutes ago — and its barrier would never run.
  if (stage.kind === 'done' || suppressed) {
    return null;
  }

  const text = stageText(stage, note.tick, note.seed);
  return (
    <div className="startup-backdrop" role="status" aria-live="polite">
      <div className="startup-card">
        <Spinner size={28} stroke={2.5} />
        <p className="startup-stage">{text.stage}</p>
        <p className="startup-note">{text.note}</p>
      </div>
    </div>
  );
}
