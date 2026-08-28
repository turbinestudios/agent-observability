import { describe, it, expect } from 'vitest';
import { parseChangelog, parseInline } from './parseChangelog';
import { RELEASES } from './releases';

const DOC = `# Changelog

Preamble that explains the file to people reading the repo.

## [1.0.2] - 2026-08-28

### Added

- **What's new** — the sparkle in the sidebar opens this changelog
  without leaving the app.

### Fixed

- A wrapped entry whose second line
  continues the same bullet.

## [1.0.1] - 2026-08-27

### Added

- Something with \`code\` and a [link](https://example.com).

## [0.1.0]

### Added

- The first release, with no date in its heading.
`;

describe('parseChangelog', () => {
  const releases = parseChangelog(DOC);

  it('reads releases newest first and drops the preamble', () => {
    expect(releases.map((r) => r.version)).toEqual(['1.0.2', '1.0.1', '0.1.0']);
  });

  it('keeps the date when the heading has one, and omits it when not', () => {
    expect(releases[0].date).toBe('2026-08-28');
    expect(releases[2].date).toBeUndefined();
  });

  it('groups items under their section', () => {
    expect(releases[0].sections.map((s) => s.title)).toEqual(['Added', 'Fixed']);
    expect(releases[0].sections[1].items).toHaveLength(1);
  });

  it('joins a wrapped bullet into one entry rather than splitting it', () => {
    const text = releases[0].sections[1].items[0].map((s) => s.text).join('');
    expect(text).toBe('A wrapped entry whose second line continues the same bullet.');
  });

  it('returns nothing for a file with no releases yet', () => {
    expect(parseChangelog('# Changelog\n\nNothing here.\n')).toEqual([]);
  });
});

describe('parseInline', () => {
  it('splits bold, code and links out of the surrounding text', () => {
    expect(parseInline('a **b** c `d` e [f](http://g) h')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'strong', text: 'b' },
      { kind: 'text', text: ' c ' },
      { kind: 'code', text: 'd' },
      { kind: 'text', text: ' e ' },
      { kind: 'link', text: 'f', href: 'http://g' },
      { kind: 'text', text: ' h' },
    ]);
  });

  it('leaves plain text as a single run', () => {
    expect(parseInline('nothing special')).toEqual([{ kind: 'text', text: 'nothing special' }]);
  });
});

describe('the shipped CHANGELOG.md', () => {
  it('parses, so the dialog is never empty in a release build', () => {
    expect(RELEASES.length).toBeGreaterThan(0);
    expect(RELEASES[0].sections.length).toBeGreaterThan(0);
  });

  it('leads with the newest release', () => {
    expect(RELEASES[0].version).toBe('1.2.0');
  });
});
