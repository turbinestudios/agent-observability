import * as fs from 'node:fs';
import { TranscriptRecord } from './transcript';

/**
 * Defensive JSON-lines parser for Claude Code transcripts.
 *
 * A transcript is appended to live while an agent runs, so the final line can be
 * a partial write; a malformed or truncated line is SKIPPED rather than aborting
 * the whole file. The parser keeps a `skipped` count so callers can surface that
 * a file was partially unreadable without throwing into the views.
 *
 * Pure (`parseTranscriptText`) + a thin filesystem wrapper (`readTranscriptFile`)
 * so the line-splitting / error-tolerance logic is unit-tested headless.
 */

export interface ParseResult {
  records: TranscriptRecord[];
  /** Non-empty lines that failed to parse (truncated/corrupt). */
  skipped: number;
}

/** Parse JSONL text into records, tolerating blank and malformed lines. */
export function parseTranscriptText(text: string): ParseResult {
  const records: TranscriptRecord[] = [];
  let skipped = 0;
  // Split on LF; tolerate CRLF by trimming \r. Avoids a regex over huge files.
  let start = 0;
  const len = text.length;
  for (let i = 0; i <= len; i += 1) {
    if (i === len || text.charCodeAt(i) === 10 /* \n */) {
      if (i > start) {
        let end = i;
        if (text.charCodeAt(end - 1) === 13 /* \r */) {
          end -= 1;
        }
        if (end > start) {
          const line = text.slice(start, end);
          const trimmed = line.trim();
          if (trimmed.length > 0) {
            const record = tryParseLine(trimmed);
            if (record !== undefined) {
              records.push(record);
            } else {
              skipped += 1;
            }
          }
        }
      }
      start = i + 1;
    }
  }
  return { records, skipped };
}

/** Read + parse a transcript file. Throws only on I/O errors (caller classifies). */
export function readTranscriptFile(path: string): ParseResult {
  const text = fs.readFileSync(path, 'utf8');
  return parseTranscriptText(text);
}

/** Parse one trimmed line into a record, or `undefined` when it is not valid. */
function tryParseLine(line: string): TranscriptRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as TranscriptRecord;
  // A record must at least carry a string `type`; anything else is noise.
  if (typeof record.type !== 'string') {
    return undefined;
  }
  return record;
}
