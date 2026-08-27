import { describe, it, expect } from 'vitest';
import { ClaudeWatcher, FileWatchFactory, WatchHandle } from './claudeWatcher';

/** A fake factory that records watches and lets the test fire events per dir. */
function fakeFactory(): {
  factory: FileWatchFactory;
  fire: (dir: string, path: string) => void;
  watched: string[];
  disposed: string[];
} {
  const handlers = new Map<string, (p: string) => void>();
  const disposed: string[] = [];
  const watched: string[] = [];
  const factory: FileWatchFactory = {
    watch(dir, onEvent): WatchHandle {
      watched.push(dir);
      handlers.set(dir, onEvent);
      return { dispose: () => disposed.push(dir) };
    },
  };
  return {
    factory,
    watched,
    disposed,
    fire: (dir, path) => handlers.get(dir)?.(path),
  };
}

describe('ClaudeWatcher', () => {
  it('watches every resolved dir and signals on a transcript event', () => {
    const { factory, fire, watched } = fakeFactory();
    let signals = 0;
    const dirs = ['/home/.claude/projects', '/cfg/projects'];
    const watcher = new ClaudeWatcher({
      resolveDirs: () => dirs,
      factory,
      signal: () => (signals += 1),
    });

    watcher.start();
    expect(watched).toEqual(dirs);

    fire('/home/.claude/projects', '/home/.claude/projects/p/s.jsonl');
    fire('/cfg/projects', '/cfg/projects/p/s.jsonl');
    expect(signals).toBe(2);
  });

  it('disposes every handle on stop', () => {
    const { factory, disposed } = fakeFactory();
    const watcher = new ClaudeWatcher({
      resolveDirs: () => ['/a', '/b'],
      factory,
      signal: () => {},
    });
    watcher.start();
    watcher.stop();
    expect(disposed.sort()).toEqual(['/a', '/b']);
  });

  it('no-ops (reports zero dirs) when no projects directory exists', () => {
    const { factory, watched } = fakeFactory();
    let watchedDirs: readonly string[] | undefined;
    const watcher = new ClaudeWatcher({
      resolveDirs: () => [],
      factory,
      signal: () => {},
      onWatching: (d) => (watchedDirs = d),
    });
    watcher.start();
    expect(watched).toEqual([]);
    expect(watchedDirs).toEqual([]);
  });

  it('reports a watch creation failure via onError without throwing', () => {
    const errors: unknown[] = [];
    const factory: FileWatchFactory = {
      watch() {
        throw new Error('watch failed');
      },
    };
    const watcher = new ClaudeWatcher({
      resolveDirs: () => ['/a'],
      factory,
      signal: () => {},
      onError: (e) => errors.push(e),
    });
    expect(() => watcher.start()).not.toThrow();
    expect(errors).toHaveLength(1);
  });
});
