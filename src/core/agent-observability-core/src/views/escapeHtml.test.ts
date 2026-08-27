import { describe, it, expect } from 'vitest';
import { escapeHtml } from './escapeHtml';
import { renderTimelineRow, renderTurn } from './sessionDetailHtml';
import { SessionTimelineEntry, SessionTurn } from '../telemetry/models';

/**
 * Security tests: crafted raw content (userRequest / finalResponse / tool name)
 * must be escaped so it cannot inject live markup/script into the local webview.
 * Raw prompt and completion content can contain arbitrary HTML and MUST be
 * rendered as text.
 */

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('>')).toBe('&gt;');
    expect(escapeHtml('&')).toBe('&amp;');
    expect(escapeHtml('"')).toBe('&quot;');
    expect(escapeHtml("'")).toBe('&#39;');
  });

  it('escapes & first so existing entities are not double-decoded into live markup', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('neutralizes a script/img injection payload', () => {
    const payload = '<img src=x onerror=alert(1)>';
    const escaped = escapeHtml(payload);
    expect(escaped).toBe('&lt;img src=x onerror=alert(1)&gt;');
    expect(escaped).not.toContain('<img');
  });
});

describe('renderTurn XSS safety', () => {
  function turn(overrides: Partial<SessionTurn>): SessionTurn {
    return {
      timestampMs: 1_700_000_000_000,
      agentMode: 'agent',
      model: 'gpt-test',
      durationMs: 1234,
      success: true,
      llmCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
      linesOfCode: 0,
      linesOfDoc: 0,
      linesOfCodeRemoved: 0,
      linesOfDocRemoved: 0,
      events: [],
      ...overrides,
    };
  }

  it('renders a crafted userRequest as escaped text, not a live tag', () => {
    const html = renderTurn(turn({ userRequest: '<img src=x onerror=alert(1)>' }));

    // The live tag must NOT appear.
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('onerror=alert(1)>');
    // The escaped form MUST appear inside the collapsible request disclosure.
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('<details');
    expect(html).toContain('User request');
  });

  it('renders a crafted finalResponse as escaped text, not a live tag', () => {
    const html = renderTurn(turn({ finalResponse: '<script>alert(1)</script>' }));

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Final LLM response');
  });
});

describe('renderTimelineRow XSS safety', () => {
  it('escapes a malicious tool name in the target column', () => {
    const entry: SessionTimelineEntry = {
      timestampMs: 1_700_000_000_000,
      operation: 'execute_tool',
      agentMode: 'agent',
      model: 'gpt-test',
      toolName: '<b>evil</b>',
      durationMs: 10,
      success: false,
    };
    const html = renderTimelineRow(entry);
    expect(html).toContain('&lt;b&gt;evil&lt;/b&gt;');
    expect(html).not.toContain('<b>evil</b>');
    // Non-chat entries do not render a user-request block.
    expect(html).not.toContain('<details');
  });
});
