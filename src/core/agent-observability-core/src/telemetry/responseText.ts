/**
 * Tolerant extractor for the raw `gen_ai.output.messages` span attribute, used
 * by the LOCAL session-detail view to surface the assistant's final response.
 *
 * The attribute follows the OTEL GenAI convention: a JSON array of message
 * objects, each with either a `parts` array of typed segments
 * (`{ type: 'text', content: '…' }`) or a plain string `content`. We concatenate
 * the human-readable TEXT from every message and ignore non-text parts (tool
 * calls, etc.).
 *
 * Robustness over precision: providers vary, and the sanitized fixture stores a
 * plain `[redacted:N]` string rather than JSON. So on any parse failure — or
 * when parsing yields no text — we fall back to the trimmed raw string. This
 * function NEVER throws, so a malformed attribute can never break the webview.
 *
 * Privacy: the input is RAW local-only content; the caller HTML-escapes the
 * result and never logs or uploads it.
 */
export function extractResponseText(raw: string): string {
  const fallback = raw.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }

  if (!Array.isArray(parsed)) {
    return fallback;
  }

  const texts: string[] = [];
  for (const message of parsed) {
    if (message === null || typeof message !== 'object') {
      continue;
    }
    const m = message as { content?: unknown; parts?: unknown };

    if (typeof m.content === 'string' && m.content.length > 0) {
      texts.push(m.content);
      continue;
    }

    if (Array.isArray(m.parts)) {
      for (const part of m.parts) {
        if (part === null || typeof part !== 'object') {
          continue;
        }
        const p = part as { type?: unknown; content?: unknown; text?: unknown };
        if (p.type !== undefined && p.type !== 'text') {
          continue;
        }
        // Different providers label the payload `content` or `text`.
        const value = typeof p.content === 'string' ? p.content : p.text;
        if (typeof value === 'string' && value.length > 0) {
          texts.push(value);
        }
      }
    }
  }

  const joined = texts.join('\n').trim();
  return joined.length > 0 ? joined : fallback;
}
