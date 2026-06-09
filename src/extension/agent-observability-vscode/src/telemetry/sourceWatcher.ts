import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveDatabasePath, PathConfig } from './paths';

/**
 * Near-live updates for the local telemetry views.
 *
 * The service already reads the freshest COMMITTED data without waiting for
 * Copilot to checkpoint — {@link ./snapshot.replayWal} folds the `-wal` frames
 * into the private snapshot copy. What it lacks is a SIGNAL to re-read: the
 * service only re-snapshots on an explicit refresh. This watcher supplies that
 * signal by observing the live `agent-traces.db` and its `-wal` sidecar (where
 * Copilot appends each committed span) and invoking `onChange` — coalesced — so
 * open panels/trees redraw shortly after Copilot writes, approximating the live
 * feel of the Agent Debug Logs.
 *
 * Why POLLING, not just `fs.watch`:
 * - Copilot keeps the `-wal` file handle OPEN for the whole session and appends
 *   a frame per committed span without closing it. On Windows/NTFS the directory
 *   entry's size/mtime is not refreshed per-append, so the directory watcher
 *   (`ReadDirectoryChangesW`, which `fs.watch` wraps) fires NOTHING until Copilot
 *   checkpoints or closes the handle — which in practice coincides with the END
 *   of an agent run. Relying on `fs.watch` alone therefore updates the views only
 *   once the whole invocation finishes (verified: a held-open append emits zero
 *   watch events; `fs.statSync(wal).size` reflects every append immediately).
 * - So the primary signal is a SIZE/MTIME POLL of the db + `-wal` via `statSync`,
 *   which DOES observe live appends. `fs.watch` is kept as a cheap supplementary
 *   fast-path (a checkpoint/close still fires it instantly); both feed the same
 *   coalescer, which dedupes and bounds how often we re-snapshot.
 *
 * It can only ever surface COMMITTED spans; the truly in-memory spans the debug
 * view shows before they hit the WAL are not on disk and remain out of reach.
 * The practical ceiling is therefore per-COMPLETED-span granularity (each tool
 * call / sub-agent turn as it commits), which is far finer than per-run.
 *
 * Debounce vs. throttle — why both bounds exist:
 * - A PURE trailing debounce (reset the timer on every write) never fires while
 *   Copilot is actively writing, because each new `-wal` append resets the quiet
 *   timer. During a long agent run the writes don't pause until the run ENDS, so
 *   a pure debounce updates the views only once the whole invocation completes —
 *   the exact "it waits for the agent to finish" symptom. To get the Agent Debug
 *   Logs' live feel we ALSO cap the wait: `maxWaitMs` guarantees a fire at least
 *   that often during a continuous write stream, surfacing each sub-agent /
 *   `chat` span as it commits to the WAL mid-run, not just at the end.
 * - The trailing `debounceMs` still coalesces a tight burst into one redraw when
 *   writes are sporadic; `maxWaitMs` only bites when writes never go quiet.
 *
 * Implementation notes:
 * - We watch the CONTAINING DIRECTORY, not the files: the `-wal`/`-shm` sidecars
 *   may not exist yet at activation, and `fs.watch` on a missing path throws.
 *   Directory watching is non-recursive and fires for the db + its sidecars.
 * - `persistent: false` so the watcher never keeps the host event loop alive.
 * - Every callback is wrapped so a watcher hiccup or an `onChange` throw can never
 *   crash the extension host.
 */
export interface SourceWatcherHandle {
  /** Stop watching and cancel any pending debounced fire. Safe to call twice. */
  dispose(): void;
}

/**
 * Default quiet period after the last detected change before firing `onChange`.
 * MUST stay greater than {@link DEFAULT_POLL_INTERVAL_MS}: during continuous
 * writing each poll tick re-arms this timer, so if it were shorter than the poll
 * interval it would elapse between ticks and fire every poll (a whole-DB copy
 * each time) instead of being capped by {@link DEFAULT_MAX_WAIT_MS}.
 */
const DEFAULT_DEBOUNCE_MS = 750;
/**
 * Default upper bound on how long a continuous write stream may delay a fire.
 * Without this, an in-progress agent run (which writes to the `-wal` without
 * pausing) would suppress every update until the run finishes. 1.5s keeps the
 * views feeling live while bounding how often the (whole-DB copy) re-snapshot
 * runs during heavy writing.
 */
const DEFAULT_MAX_WAIT_MS = 1500;
/**
 * Default interval at which the db + `-wal` size/mtime is polled. This is the
 * PRIMARY change signal (see the file header on why `fs.watch` misses held-open
 * WAL appends on Windows). 500ms keeps detection latency low; the coalescer's
 * {@link DEFAULT_MAX_WAIT_MS} cap still bounds how often the (whole-DB copy)
 * re-snapshot actually runs during continuous writing.
 */
const DEFAULT_POLL_INTERVAL_MS = 500;

/** Sidecar suffix Copilot appends each committed span to (held open per session). */
const WAL_SUFFIX = '-wal';

/**
 * A cheap change fingerprint of the telemetry source: the size + mtime of the
 * main `.db` and its `-wal` sidecar. Crucially this reads `statSync`, which
 * reflects live appends to a file another process holds open (unlike directory
 * watch notifications). Missing files contribute a sentinel so appearance /
 * disappearance also registers as a change. Exported for unit testing.
 */
export function sourceSignature(dbPath: string): string {
  return [dbPath, `${dbPath}${WAL_SUFFIX}`].map(statToken).join('|');
}

/** `size:mtimeMs` for a path, or `-` when it cannot be stat'd (absent/denied). */
function statToken(p: string): string {
  try {
    const s = fs.statSync(p);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return '-';
  }
}

/**
 * Whether a directory-watch event for `filename` concerns the telemetry database
 * `base` (e.g. `agent-traces.db`) or one of its sidecars (`-wal`, `-shm`,
 * `-journal`). A `null` filename (some platforms omit it) is treated as relevant
 * so we never miss a write. Exported for unit testing the (pure) filter.
 */
export function isRelevantChange(base: string, filename: string | null): boolean {
  if (filename === null) {
    return true;
  }
  return filename === base || filename.startsWith(`${base}-`);
}

/** A coalescer's input surface: signal a change, or tear it down. */
export interface Coalescer {
  /** Note that a change occurred; may schedule a future `fire`. */
  schedule(): void;
  /** Cancel any pending fire; subsequent `schedule()` calls become no-ops. */
  cancel(): void;
}

/**
 * Build a debounce-with-max-wait coalescer over `fire`, independent of `fs` so
 * the timing contract is unit-testable with fake timers.
 *
 * - `debounceMs`: trailing quiet period. Each {@link Coalescer.schedule} resets
 *   it, so a tight burst collapses to a single `fire` once writes pause.
 * - `maxWaitMs`: hard cap. Started on the FIRST schedule of a burst and never
 *   reset, it guarantees a `fire` even when `schedule()` is called continuously
 *   and the trailing timer would otherwise never elapse — the in-progress agent
 *   run case. Both timers are cleared whenever a `fire` lands, so the next burst
 *   starts a fresh cycle.
 */
export function createCoalescer(
  fire: () => void,
  debounceMs: number,
  maxWaitMs: number,
): Coalescer {
  // `timer` is the trailing-debounce (reset on every change); `maxTimer` is the
  // max-wait cap (started once per burst, NOT reset). Both cleared on a fire.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let maxTimer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;

  const run = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (maxTimer !== undefined) {
      clearTimeout(maxTimer);
      maxTimer = undefined;
    }
    if (cancelled) {
      return;
    }
    fire();
  };

  return {
    schedule(): void {
      if (cancelled) {
        return;
      }
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      timer = setTimeout(run, debounceMs);
      // Start the cap on the first change of a burst only; resetting it here
      // would recreate the pure-debounce starvation we are avoiding.
      if (maxTimer === undefined) {
        maxTimer = setTimeout(run, maxWaitMs);
      }
    },
    cancel(): void {
      cancelled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (maxTimer !== undefined) {
        clearTimeout(maxTimer);
        maxTimer = undefined;
      }
    },
  };
}

/**
 * Begin watching the resolved telemetry source and call `onChange` whenever the
 * db or its `-wal` sidecar changes. Detection is primarily a `statSync` size/
 * mtime POLL every `pollIntervalMs` (default {@link DEFAULT_POLL_INTERVAL_MS}) —
 * the only signal that catches Copilot's held-open WAL appends on Windows — with
 * `fs.watch` kept as a supplementary fast-path for checkpoints/closes. Both feed
 * a coalescer: a trailing debounce (`debounceMs`, default
 * {@link DEFAULT_DEBOUNCE_MS}) collapses a sporadic burst into one fire, and a
 * max wait (`maxWaitMs`, default {@link DEFAULT_MAX_WAIT_MS}) guarantees a fire
 * at least that often during a CONTINUOUS write stream so an in-progress agent
 * run updates the views mid-run instead of only on completion.
 *
 * Returns a no-op handle when no source path can be resolved — the caller's
 * manual Refresh still works then. A missing directory is NOT fatal here: the
 * poller tolerates absence and starts reporting changes once the DB appears.
 */
export function watchTelemetrySource(
  config: PathConfig,
  onChange: () => void,
  options: { debounceMs?: number; maxWaitMs?: number; pollIntervalMs?: number } = {},
): SourceWatcherHandle {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const resolved = resolveDatabasePath(config);
  if (resolved.path === undefined) {
    return { dispose() {} };
  }

  const dbPath = resolved.path;
  const dir = path.dirname(dbPath);
  const base = path.basename(dbPath);

  let disposed = false;
  const coalescer = createCoalescer(
    () => {
      if (disposed) {
        return;
      }
      try {
        onChange();
      } catch {
        // A redraw failure must never tear down the watcher or the host.
      }
    },
    debounceMs,
    maxWaitMs,
  );

  // PRIMARY signal: poll the db + `-wal` fingerprint; schedule only on a real
  // change so an idle source never triggers a (whole-DB copy) re-snapshot.
  let lastSignature = sourceSignature(dbPath);
  const poll = setInterval(() => {
    if (disposed) {
      return;
    }
    const sig = sourceSignature(dbPath);
    if (sig !== lastSignature) {
      lastSignature = sig;
      coalescer.schedule();
    }
  }, pollIntervalMs);
  // Never keep the extension host event loop alive on our account.
  poll.unref?.();

  // SUPPLEMENTARY fast-path: a checkpoint/close DOES fire the directory watcher,
  // delivering the update instantly rather than on the next poll tick. Best-effort
  // — if the directory cannot be watched yet, the poller alone still works.
  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = fs.watch(dir, { persistent: false }, (_eventType, filename) => {
      if (isRelevantChange(base, filename === null ? null : filename.toString())) {
        // Refresh the baseline so the poller doesn't re-fire for the same change.
        lastSignature = sourceSignature(dbPath);
        coalescer.schedule();
      }
    });
    watcher.on('error', () => {
      /* swallow; dispose handles teardown */
    });
  } catch {
    // Directory not watchable yet; the poller is sufficient on its own.
  }

  return {
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      clearInterval(poll);
      coalescer.cancel();
      try {
        watcher?.close();
      } catch {
        // Already closed; ignore.
      }
    },
  };
}
