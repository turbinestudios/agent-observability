import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ImprovePromptDialog } from './ImprovePromptDialog';
import type { ContextPromptFacts } from '../../../../shared/rpc';

/**
 * Rendered to static markup, inside this package's node-only test setup. The
 * prompt text itself is pinned by core's improvePrompt tests; this checks the
 * dialog opens on the right scope and shows the counts and the copy action.
 */

function facts(flagged: boolean): ContextPromptFacts {
  return {
    agentName: 'Main Agent',
    files: [
      { name: 'CLAUDE.md', category: 'instruction', estimatedTokens: 4800, oversized: flagged, missingRefs: [] },
      { name: 'reflect', category: 'skill', estimatedTokens: 120, oversized: false, missingRefs: [] },
    ],
    contextFileTokens: 4920,
    totalContextTokens: 20000,
  };
}

const render = (f: ContextPromptFacts): string =>
  renderToStaticMarkup(createElement(ImprovePromptDialog, { facts: f, onClose: () => undefined }));

describe('ImprovePromptDialog', () => {
  it('opens on the flagged files, with both scope counts and the copy action', () => {
    const html = render(facts(true));
    expect(html).toContain('Files with warnings (1)');
    expect(html).toContain('All loaded files (2)');
    expect(html).toContain('Copy prompt');
    expect(html).toContain('`CLAUDE.md`');
    expect(html).not.toContain('`reflect`');
  });

  it('opens on all files, with the flagged choice disabled, when nothing is flagged', () => {
    const html = render(facts(false));
    expect(html).toContain('`reflect`');
    expect(html).toMatch(/<input[^>]*disabled[^>]*\/?>Files with warnings \(0\)/);
  });
});
