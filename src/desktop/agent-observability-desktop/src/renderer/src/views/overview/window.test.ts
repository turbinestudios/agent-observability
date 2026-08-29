import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  persistWindow,
  readStoredWindow,
  windowDescription,
  windowLabel,
  windowRange,
} from './window';
import { windowStartMs } from '../../../../shared/rpc';

/**
 * The window is the one Dashboard control whose value leaves the view: it is
 * persisted across restarts, sent to the data host, and carried into the
 * session list by a drill-down. Each of those is a chance for it to be
 * something other than a window, so each is pinned here.
 */

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('remembering the choice', () => {
  it('round-trips a day count through storage, which only holds strings', () => {
    persistWindow(90);
    expect(readStoredWindow()).toBe(90);
  });

  it("round-trips 'all'", () => {
    persistWindow('all');
    expect(readStoredWindow()).toBe('all');
  });

  it('defaults to 30 days on a first run', () => {
    expect(readStoredWindow()).toBe(30);
  });

  it('falls back to the default rather than trusting a hand-edited value', () => {
    store.set('agent-observability.overviewWindow', '9999');
    expect(readStoredWindow()).toBe(30);
    store.set('agent-observability.overviewWindow', 'nonsense');
    expect(readStoredWindow()).toBe(30);
  });

  it('survives storage being unavailable, rather than failing to open', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('storage disabled');
        },
        setItem: () => {
          throw new Error('storage disabled');
        },
      },
    });
    expect(readStoredWindow()).toBe(30);
    expect(() => persistWindow(7)).not.toThrow();
  });
});

describe('labels', () => {
  it('is short enough for a four-way segmented control', () => {
    expect(windowLabel(7)).toBe('7d');
    expect(windowLabel('all')).toBe('All time');
  });

  it('spells itself out for prose', () => {
    expect(windowDescription(30)).toBe('the last 30 days');
    expect(windowDescription('all')).toBe('all time');
  });
});

describe('the range a drill-down carries', () => {
  it('starts at a local midnight, matching the columns the charts draw', () => {
    const now = new Date(2026, 7, 20, 15, 30).getTime();
    const { endedAfterMs } = windowRange(7, now);
    expect(endedAfterMs).toBe(windowStartMs(7, now));
    expect(new Date(endedAfterMs!).getHours()).toBe(0);
    // Seven days ending today means today plus the six before it.
    expect(new Date(endedAfterMs!).getDate()).toBe(14);
  });

  it('carries no range for all time, which excludes nothing', () => {
    expect(windowRange('all')).toEqual({});
  });
});
