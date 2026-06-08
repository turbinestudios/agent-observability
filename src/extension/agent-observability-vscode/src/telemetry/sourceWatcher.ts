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
 * signal by watching the live `agent-traces.db` and its `-wal` sidecar (where
 * Copilot appends each committed span) and invoking `onChange` — debounced — so
 * open panels/trees redraw shortly after Copilot writes, approximating the live
 * feel of the Agent Debug Logs.
 *
 * It can only ever surface COMMITTED spans; the truly in-memory spans the debug
 * view shows before they hit the WAL are not on disk and remain out of reach.
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

/** Default quiet period after the last write before firing `onChange`. */
const DEFAULT_DEBOUNCE_MS = 750;

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

/**
 * Begin watching the resolved telemetry source and call `onChange` (debounced by
 * `debounceMs`, default {@link DEFAULT_DEBOUNCE_MS}) whenever the db or a sidecar
 * changes. Returns a no-op handle when no source path can be resolved or the
 * directory cannot be watched (e.g. it does not exist yet) — the caller's manual
 * Refresh still works in that case.
 */
export function watchTelemetrySource(
  config: PathConfig,
  onChange: () => void,
  options: { debounceMs?: number } = {},
): SourceWatcherHandle {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const resolved = resolveDatabasePath(config);
  if (resolved.path === undefined) {
    return { dispose() {} };
  }

  const dir = path.dirname(resolved.path);
  const base = path.basename(resolved.path);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const fire = (): void => {
    timer = undefined;
    if (disposed) {
      return;
    }
    try {
      onChange();
    } catch {
      // A redraw failure must never tear down the watcher or the host.
    }
  };

  const schedule = (): void => {
    if (disposed) {
      return;
    }
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(fire, debounceMs);
  };

  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(dir, { persistent: false }, (_eventType, filename) => {
      if (isRelevantChange(base, filename === null ? null : filename.toString())) {
        schedule();
      }
    });
  } catch {
    // Directory not watchable (missing / unsupported). Manual refresh still works.
    return { dispose() {} };
  }

  // A watcher error (e.g. the directory is removed) should quietly stop watching
  // rather than surface an uncaught exception in the host.
  watcher.on('error', () => {
    /* swallow; dispose handles teardown */
  });

  return {
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      try {
        watcher.close();
      } catch {
        // Already closed; ignore.
      }
    },
  };
}
