import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LiveBoardSnapshot, LiveSessionRow } from '../../../../shared/rpc';
import { LiveBoard } from './LiveBoard';

function row(overrides: Partial<LiveSessionRow> = {}): LiveSessionRow {
  return {
    source: 'claude',
    sessionId: 's1',
    repository: 'https://github.com/o/repo',
    title: 'Add the live board',
    status: 'working',
    lastEvent: 'tool-pending',
    startedAtMs: 1_000,
    lastActivityMs: 1_000,
    pendingTools: ['Bash'],
    inputTokens: 1500,
    outputTokens: 500,
    countsIndexedAtMs: 1_000,
    ...overrides,
  };
}

function render(snapshot: LiveBoardSnapshot | undefined, nowMs = 10 * 60_000): string {
  return renderToStaticMarkup(
    createElement(LiveBoard, { snapshot, nowMs, onOpenSession: () => undefined }),
  );
}

const base: LiveBoardSnapshot = {
  rows: [],
  generatedAtMs: 0,
  watching: true,
  watchedDirs: 1,
  idleMs: 180_000,
  finishedMs: 1_800_000,
};

describe('LiveBoard', () => {
  it('shows the empty state with the window length once the snapshot has arrived', () => {
    const html = render(base);
    expect(html).toContain('No sessions in the last 30 minutes');
    expect(html).toContain('Nothing running');
  });

  it('renders a card with status chip, branch chip and the long-pending hint', () => {
    const html = render({ ...base, rows: [row({ branch: 'feat/live' })] });
    expect(html).toContain('Working');
    expect(html).toContain('Add the live board');
    expect(html).toContain('feat/live');
    expect(html).toContain('shown on this computer only');
    expect(html).toContain('may be waiting for your approval');
    expect(html).toContain('o/repo');
  });

  it('surfaces the degraded note and loading state', () => {
    expect(render({ ...base, note: 'Claude Code is turned off in Settings' })).toContain('turned off in Settings');
    expect(render(undefined)).toContain('Loading…');
  });

  it('narrows to one repository when asked', () => {
    const html = renderToStaticMarkup(
      createElement(LiveBoard, {
        snapshot: { ...base, rows: [row(), row({ sessionId: 'other', repository: 'https://github.com/o/else', title: 'Elsewhere' })] },
        nowMs: 10_000,
        repository: 'https://github.com/o/repo',
        onOpenSession: () => undefined,
      }),
    );
    expect(html).toContain('Add the live board');
    expect(html).not.toContain('Elsewhere');
    expect(html).toContain('Live now');
  });
});
