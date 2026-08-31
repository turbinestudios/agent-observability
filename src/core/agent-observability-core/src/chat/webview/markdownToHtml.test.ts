import { describe, it, expect } from 'vitest';
import { markdownToHtml } from './markdownToHtml';

describe('markdownToHtml — security', () => {
  it('escapes raw HTML so a script tag cannot execute', () => {
    const html = markdownToHtml('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('neutralizes an img onerror payload', () => {
    const html = markdownToHtml('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('does not emit a javascript: link — renders it as text', () => {
    const html = markdownToHtml('[click](javascript:alert(1))');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('click');
  });

  it('renders an http(s) link as an anchor with rel guards', () => {
    const html = markdownToHtml('[VS Code](https://code.visualstudio.com)');
    expect(html).toContain('<a href="https://code.visualstudio.com"');
    expect(html).toContain('rel="noreferrer noopener"');
    expect(html).toContain('>VS Code</a>');
  });

  it('cannot break out of an href attribute via an embedded quote', () => {
    const html = markdownToHtml('[x](https://e.com/"onmouseover=alert(1))');
    expect(html).not.toContain('"onmouseover');
    expect(html).toContain('&quot;onmouseover');
  });

  it('escapes ampersands and quotes in plain text', () => {
    const html = markdownToHtml('Tom & "Jerry"');
    expect(html).toContain('Tom &amp; &quot;Jerry&quot;');
  });

  it('escapes code-block contents and never executes them', () => {
    const html = markdownToHtml('```\n<script>x</script>\n```');
    expect(html).toContain('<pre><code>');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('closes an unclosed fence instead of leaking the rest as markup', () => {
    const html = markdownToHtml('```\n<b>not bold</b>');
    expect(html).toContain('&lt;b&gt;not bold');
    expect(html).not.toContain('<b>not bold</b>');
  });
});

describe('markdownToHtml — structure', () => {
  it('renders headings at the right level', () => {
    expect(markdownToHtml('## Title')).toBe('<h2>Title</h2>');
  });

  it('renders bold, italic and inline code', () => {
    expect(markdownToHtml('**b** _i_ `c`')).toBe('<p><strong>b</strong> <em>i</em> <code>c</code></p>');
  });

  it('does not format markers inside inline code', () => {
    expect(markdownToHtml('`a *b* c`')).toBe('<p><code>a *b* c</code></p>');
  });

  it('renders unordered and ordered lists', () => {
    expect(markdownToHtml('- one\n- two')).toBe('<ul><li>one</li><li>two</li></ul>');
    expect(markdownToHtml('1. one\n2. two')).toBe('<ol><li>one</li><li>two</li></ol>');
  });

  it('renders a blockquote', () => {
    expect(markdownToHtml('> quoted')).toBe('<blockquote>quoted</blockquote>');
  });

  it('renders a horizontal rule', () => {
    expect(markdownToHtml('---')).toBe('<hr />');
  });

  it('preserves the fence info string as data-lang (for Apply buttons)', () => {
    const html = markdownToHtml('```ao-workflows\n[]\n```');
    expect(html).toContain('class="code-block" data-lang="ao-workflows"');
  });

  it('soft-joins consecutive paragraph lines', () => {
    expect(markdownToHtml('line one\nline two')).toBe('<p>line one line two</p>');
  });
});

describe('markdownToHtml — tables', () => {
  it('renders a pipe table with header and body rows', () => {
    const html = markdownToHtml('| Rank | Session |\n|---|---|\n| 1 | Alpha |\n| 2 | Beta |');
    expect(html).toBe(
      '<div class="table-wrap"><table><thead><tr><th>Rank</th><th>Session</th></tr></thead>' +
        '<tbody><tr><td>1</td><td>Alpha</td></tr><tr><td>2</td><td>Beta</td></tr></tbody></table></div>',
    );
  });

  it('accepts alignment colons in the delimiter row', () => {
    const html = markdownToHtml('| a | b |\n|:---|---:|\n| 1 | 2 |');
    expect(html).toContain('<th>a</th><th>b</th>');
    expect(html).toContain('<td>1</td><td>2</td>');
  });

  it('escapes cell contents before any tag is introduced', () => {
    const html = markdownToHtml('| x |\n|---|\n| <script>alert(1)</script> |');
    expect(html).not.toContain('<script>');
    expect(html).toContain('<td>&lt;script&gt;alert(1)&lt;/script&gt;</td>');
  });

  it('renders inline markup inside cells', () => {
    const html = markdownToHtml('| a |\n|---|\n| **bold** `code` |');
    expect(html).toContain('<td><strong>bold</strong> <code>code</code></td>');
  });

  it('squares ragged rows to the header width', () => {
    const html = markdownToHtml('| a | b |\n|---|---|\n| only |\n| 1 | 2 | extra |');
    expect(html).toContain('<tr><td>only</td><td></td></tr>');
    expect(html).toContain('<tr><td>1</td><td>2</td></tr>');
    expect(html).not.toContain('extra');
  });

  it('ends a preceding paragraph where a table starts', () => {
    const html = markdownToHtml('intro text\n| a | b |\n|---|---|\n| 1 | 2 |');
    expect(html).toContain('<p>intro text</p>');
    expect(html).toContain('<th>a</th>');
    expect(html).not.toContain('intro text |');
  });

  it('keeps a pipe-bearing line without a delimiter row as a paragraph', () => {
    expect(markdownToHtml('either | or')).toBe('<p>either | or</p>');
  });

  it('keeps a plain dash run as a horizontal rule, not a table delimiter', () => {
    expect(markdownToHtml('---')).toBe('<hr />');
  });
});
