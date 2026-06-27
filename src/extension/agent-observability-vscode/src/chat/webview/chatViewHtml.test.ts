import { describe, it, expect } from 'vitest';
import { renderChatHtml } from './chatViewHtml';
import { QUICK_COMMANDS } from '../quickCommands';

describe('renderChatHtml', () => {
  const nonce = 'TESTNONCE123';
  const html = renderChatHtml(nonce);

  it('sets a strict CSP with the nonce and no external/inline-script escape', () => {
    expect(html).toContain(
      `content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src 'none'; font-src 'none';"`,
    );
  });

  it('nonces both the style and the script tags', () => {
    expect(html).toContain(`<style nonce="${nonce}">`);
    expect(html).toContain(`<script nonce="${nonce}">`);
  });

  it('renders a quick-command button for every shipped command', () => {
    for (const c of QUICK_COMMANDS) {
      expect(html).toContain(`data-cmd="${c.id}"`);
      expect(html).toContain(c.label);
    }
  });

  it('includes the input, send and stop controls', () => {
    expect(html).toContain('id="input"');
    expect(html).toContain('id="send"');
    expect(html).toContain('id="stop"');
  });

  it('does not reference any external resource (CSP would block it anyway)', () => {
    expect(html).not.toMatch(/src="https?:/);
    expect(html).not.toMatch(/href="https?:\/\//);
  });
});
