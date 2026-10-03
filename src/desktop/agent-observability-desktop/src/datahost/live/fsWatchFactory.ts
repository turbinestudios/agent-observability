import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FileWatchFactory, WatchHandle } from '@agent-observability/core/src/live/claudeWatcher';

/**
 * Core's {@link FileWatchFactory} seam over Node's own `fs.watch`.
 *
 * `fs.watch` rather than chokidar on purpose: chokidar 5 is ESM-only while
 * the datahost bundle is CommonJS, and a recursive native watch is one OS
 * handle per tree on Windows and macOS (Linux gets Node's inotify emulation),
 * which is what a `~/.claude/projects` tree with hundreds of project folders
 * needs. Events here are only a hint — the live board re-stats and re-reads
 * the files it cares about on every signal, so a missed or duplicated event
 * costs nothing but a little latency.
 */
export interface FsWatchOptions {
  /** Watch the whole tree below a directory target. Ignored for file targets. */
  recursive?: boolean;
  /** Only report paths ending in this (lower-cased) extension, e.g. `.jsonl`. */
  extension?: string;
}

export function fsWatchFactory(options: FsWatchOptions = {}): FileWatchFactory {
  return {
    watch(target: string, onEvent: (changedPath: string) => void): WatchHandle {
      const isDirectory = safeIsDirectory(target);
      const watcher = fs.watch(
        target,
        { persistent: false, recursive: isDirectory && (options.recursive ?? true) },
        (_eventType, filename) => {
          try {
            const name = filename === null || filename === undefined ? undefined : String(filename);
            const full = isDirectory && name !== undefined && name.length > 0 ? path.join(target, name) : target;
            if (
              options.extension !== undefined &&
              isDirectory &&
              !full.toLowerCase().endsWith(options.extension)
            ) {
              return;
            }
            onEvent(path.normalize(full));
          } catch {
            // Never throw out of the event callback — see FileWatchFactory.
          }
        },
      );
      // A watch that errors (folder removed, handle limit) degrades to the
      // board's periodic tick rather than crashing the datahost.
      watcher.on('error', () => undefined);
      return {
        dispose() {
          try {
            watcher.close();
          } catch {
            // best-effort
          }
        },
      };
    },
  };
}

function safeIsDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}
