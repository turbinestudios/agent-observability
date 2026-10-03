import * as fs from 'node:fs';
import { parseTranscriptText } from './parser';
import type { TranscriptRecord } from './transcript';

/**
 * Tail reader for Claude Code transcripts.
 *
 * A live transcript can be tens of megabytes, but deciding whether the agent is
 * working, waiting or idle only needs its last few records. This module reads
 * the final `maxBytes` of the file in one `readSync`, drops the (probably
 * partial) first line of that window, and parses the rest with the same
 * defensive parser the indexer uses. Nothing here keeps a handle open or
 * throws: an I/O failure (file gone between stat and read, permission) yields
 * `undefined` and the caller treats the session as unobservable for this tick.
 *
 * LOCAL-ONLY: the records returned carry raw content exactly like a full parse;
 * the live board reads only metadata off them and nothing reaches any
 * aggregate/sync path.
 */

/** Default tail window: comfortably more than a few turns of tool traffic. */
export const DEFAULT_TAIL_BYTES = 256 * 1024;

export interface TranscriptTail {
  records: TranscriptRecord[];
  /** Non-empty lines in the window that failed to parse. */
  skipped: number;
  /** Whole-file size at read time. */
  sizeBytes: number;
  /** File mtime in epoch ms. */
  mtimeMs: number;
  /** `true` when the window did not start at byte 0 (an earlier part was skipped). */
  truncated: boolean;
}

/** Filesystem seam so the windowing logic is unit-testable against fakes. */
export interface TailFs {
  openSync(path: string, flags: 'r'): number;
  fstatSync(fd: number): { size: number; mtimeMs: number };
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  closeSync(fd: number): void;
}

const defaultTailFs: TailFs = {
  openSync: (p, flags) => fs.openSync(p, flags),
  fstatSync: (fd) => {
    const stat = fs.fstatSync(fd);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  },
  readSync: (fd, buffer, offset, length, position) => fs.readSync(fd, buffer, offset, length, position),
  closeSync: (fd) => fs.closeSync(fd),
};

/**
 * The text of a tail window. When the window started mid-file, everything up to
 * and including the first newline is a partial line (and may begin inside a
 * multi-byte UTF-8 sequence), so it is discarded before decoding.
 */
export function tailText(buffer: Buffer, startedMidFile: boolean): string {
  if (!startedMidFile) {
    return buffer.toString('utf8');
  }
  const newline = buffer.indexOf(10 /* \n */);
  if (newline < 0) {
    return '';
  }
  return buffer.subarray(newline + 1).toString('utf8');
}

/** Read and parse the last `maxBytes` of a transcript. Never throws. */
export function readTranscriptTail(
  path: string,
  maxBytes: number = DEFAULT_TAIL_BYTES,
  fsSeam: TailFs = defaultTailFs,
): TranscriptTail | undefined {
  let fd: number | undefined;
  try {
    fd = fsSeam.openSync(path, 'r');
    const { size, mtimeMs } = fsSeam.fstatSync(fd);
    const window = Math.max(0, Math.min(size, Math.floor(maxBytes)));
    const offset = size - window;
    const buffer = Buffer.alloc(window);
    let read = 0;
    while (read < window) {
      const n = fsSeam.readSync(fd, buffer, read, window - read, offset + read);
      if (n <= 0) {
        break;
      }
      read += n;
    }
    const truncated = offset > 0;
    const { records, skipped } = parseTranscriptText(tailText(buffer.subarray(0, read), truncated));
    return { records, skipped, sizeBytes: size, mtimeMs, truncated };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fsSeam.closeSync(fd);
      } catch {
        // best-effort
      }
    }
  }
}
