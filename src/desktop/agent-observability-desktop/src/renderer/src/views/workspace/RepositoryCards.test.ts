import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RepositoryCards as Data } from '../../../../shared/rpc';
import { RepositoryCards } from './RepositoryCards';

const data: Data = {
  window: 30,
  unknownSessions: 2,
  cards: [
    {
      repository: 'https://github.com/o/repo',
      sessions: 12,
      lastActivityMs: 5_000,
      live: 2,
      waiting: 1,
      bySource: [
        { source: 'claude', sessions: 10 },
        { source: 'copilot', sessions: 2 },
      ],
      verdicts: { smooth: 6, bumpy: 3, struggled: 2, abandoned: 1, unjudged: 0 },
      costMicros: 12_340_000,
      costSessions: 10,
    },
  ],
};

describe('RepositoryCards', () => {
  it('renders the card with live badge, counts, sources and verdict bar', () => {
    const html = renderToStaticMarkup(createElement(RepositoryCards, { data, nowMs: 10_000, onOpen: () => undefined }));
    expect(html).toContain('o/repo');
    expect(html).toContain('1 waiting');
    expect(html).toContain('12 sessions');
    expect(html).toContain('Claude Code 10');
    expect(html).toContain('verdict-seg-smooth');
    expect(html).toContain('width:50%');
    expect(html).toContain('2 sessions without a repository');
  });

  it('shows the empty state when the window holds nothing', () => {
    const html = renderToStaticMarkup(
      createElement(RepositoryCards, { data: { ...data, cards: [], unknownSessions: 0 }, onOpen: () => undefined }),
    );
    expect(html).toContain('No sessions in this window');
  });
});
