import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChangelogDialog } from './ChangelogDialog';

/**
 * The dialog reads the real shipped `CHANGELOG.md`, so this is the check that
 * the file and the renderer still agree: a heading typo that made the dialog
 * come up empty would otherwise surface only in a release build, in front of a
 * user.
 *
 * Rendered to static markup rather than into a DOM, so it stays inside this
 * package's node-only test setup — see vitest.config.ts.
 */
const html = renderToStaticMarkup(createElement(ChangelogDialog, { onClose: () => undefined }));

describe('ChangelogDialog', () => {
  it('renders the newest release with its date', () => {
    expect(html).toContain('1.2.0');
    expect(html).toContain('2026-08-28');
  });

  it('renders every release in the file, not just the newest', () => {
    for (const version of ['1.2.0', '1.1.0', '1.0.3', '1.0.1', '1.0.0']) {
      expect(html).toContain(version);
    }
  });

  it('renders group headings and their items', () => {
    expect(html).toContain('Fixed');
    expect(html).toContain('<li>');
  });

  it('renders bold runs as elements, leaving no markup visible', () => {
    expect(html).toContain('<strong>');
    expect(html).not.toContain('**');
  });

  it('is a labelled modal dialog', () => {
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('id="changelog-title"');
  });
});
