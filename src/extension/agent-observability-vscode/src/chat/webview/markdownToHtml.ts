import { escapeHtml } from '../../views/escapeHtml';

/**
 * A tiny, dependency-free, CSP-safe Markdown → HTML renderer for assistant
 * messages in the AI Helper webview.
 *
 * SECURITY BOUNDARY. The model output is untrusted. The invariant is: **every
 * leaf of text is HTML-escaped via {@link escapeHtml} before any structural tag
 * is introduced**, and the renderer only ever emits a fixed whitelist of tags
 * (`p`, `br`, `h1`–`h6`, `strong`, `em`, `code`, `pre`, `ul`/`ol`/`li`,
 * `blockquote`, `hr`, `a`, and the `div.code-block` wrapper). It never emits
 * `script`, `img`, `style`, event handlers, or inline scripts, and link hrefs
 * are restricted to `http(s)`/`mailto` (anything else renders as plain text). The
 * webview assigns the result via `innerHTML`; the strict CSP (`script-src
 * 'nonce-…'`) means even if a tag slipped through it could not execute script.
 *
 * Pure (no `vscode`); unit-tested in `markdownToHtml.test.ts`.
 */

/** Render Markdown text to a CSP-safe HTML string. */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block: ``` optionally followed by an info string.
    const fence = /^\s*```+\s*(.*)$/.exec(line);
    if (fence) {
      const lang = fence[1].trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      // Skip the closing fence when present (an unclosed block still closes here).
      if (i < lines.length) {
        i++;
      }
      out.push(renderCodeBlock(lang, body.join('\n')));
      continue;
    }

    // Blank line — paragraph separator.
    if (line.trim().length === 0) {
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push('<hr />');
      i++;
      continue;
    }

    // Heading (# .. ######).
    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    // Unordered list — consecutive `-`, `*`, or `+` items.
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].replace(/^\s*[-*+]\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // Ordered list — consecutive `1.`/`1)` items.
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(`<li>${renderInline(lines[i].replace(/^\s*\d+[.)]\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // Blockquote — consecutive `>` lines.
    if (/^\s*>\s?/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${renderInline(quoted.join(' '))}</blockquote>`);
      continue;
    }

    // Paragraph — consecutive plain lines, soft-joined with a space.
    const para: string[] = [];
    while (i < lines.length && !isBlockStart(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${renderInline(para.join(' '))}</p>`);
  }

  return out.join('\n');
}

/** Whether a line begins a non-paragraph block (stops paragraph accumulation). */
function isBlockStart(line: string): boolean {
  return (
    line.trim().length === 0 ||
    /^\s*```+/.test(line) ||
    /^\s*(#{1,6})\s+/.test(line) ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+[.)]\s+/.test(line) ||
    /^\s*>\s?/.test(line) ||
    /^\s*([-*_])\1{2,}\s*$/.test(line)
  );
}

/**
 * Emit a fenced code block. The info string becomes `data-lang` (escaped, used
 * by the webview to decide whether to offer an Apply button for `ao-workflows` /
 * `ao-config`). The body is escaped verbatim — never inline-formatted.
 */
function renderCodeBlock(lang: string, body: string): string {
  return `<div class="code-block" data-lang="${escapeHtml(lang)}"><pre><code>${escapeHtml(body)}</code></pre></div>`;
}

/**
 * Render inline Markdown on a single text run. Escapes first, then introduces
 * only whitelisted inline tags. Inline code spans are extracted up front so their
 * contents are never touched by the emphasis/link transforms.
 */
export function renderInline(raw: string): string {
  const escaped = escapeHtml(raw);
  // Split out `code` spans (backticks survive escaping) and transform the rest.
  return escaped
    .split(/(`[^`]+`)/g)
    .map((segment) => {
      const code = /^`([^`]+)`$/.exec(segment);
      if (code) {
        return `<code>${code[1]}</code>`;
      }
      return renderEmphasisAndLinks(segment);
    })
    .join('');
}

/** Apply links, then bold, then italic to an escaped, code-free text run. */
function renderEmphasisAndLinks(escaped: string): string {
  let s = escaped;
  // Links: [label](url) — url already escaped; restrict the scheme.
  s = s.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) =>
    renderLink(label, url),
  );
  // Bold (consume `**` first so leftover single `*` are italic).
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic — `*text*` or `_text_`.
  s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  s = s.replace(/_([^_\n]+)_/g, '<em>$1</em>');
  return s;
}

/** Render a link only for safe schemes; otherwise fall back to plain text. */
function renderLink(label: string, url: string): string {
  const lower = url.toLowerCase();
  const safe =
    lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('mailto:');
  if (!safe) {
    return `${label} (${url})`;
  }
  return `<a href="${url}" rel="noreferrer noopener">${label}</a>`;
}
