import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CostMode, SessionDetail } from '@agent-observability/core/src/telemetry/models';
import {
  buildSharedSession,
  isShareableSource,
  parseSharedSession,
  sharedSessionId,
} from '@agent-observability/core/src/share/sharedSession';
import {
  SHARED_SESSION_EXTENSION,
  SHARED_SESSION_MAX_BYTES,
  SHARED_SOURCE_ID,
} from '@agent-observability/core/src/share/sharedSessionModels';
import type { ShareExportResult, ShareImportResult, SharePreview } from '../../shared/rpc';

/**
 * Sharing one session as a file, and importing one.
 *
 * Export is the only path in the app that writes a session's raw content
 * (prompts, responses, tool names) to a file. It runs only after the share
 * dialog has said exactly that, and only to the file the user picked in the
 * save dialog. The app never sends the file anywhere.
 *
 * Import validates the whole file before keeping anything. A file that fails
 * is reported and nothing is stored, so a half-read session can never appear
 * in the list.
 */

/** The app's own folder of imported sessions, one `<id>.json` each. */
export function resolveSharedDir(): string {
  return path.join(os.homedir(), '.agent-observability', 'desktop', 'shared');
}

export interface ShareSessionInput {
  source: string;
  sessionId: string;
  detail: () => SessionDetail;
  costMode: CostMode;
  /** The name the user sees for the session, a rename included. */
  title?: string;
  toolVersion: string;
  nowMs: number;
}

type Built = { ok: true; json: string; turns: number; redactions: number; kinds: string[]; title?: string } | { ok: false; message: string };

function build(input: ShareSessionInput): Built {
  if (!isShareableSource(input.source)) {
    return { ok: false, message: 'A session imported from someone else cannot be shared again.' };
  }
  let detail: SessionDetail;
  try {
    detail = input.detail();
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  const built = buildSharedSession({
    detail,
    source: input.source,
    costMode: input.costMode,
    ...(input.title !== undefined ? { title: input.title } : {}),
    toolVersion: input.toolVersion,
    nowMs: input.nowMs,
  });
  if (!built.ok) {
    return built;
  }
  const json = `${JSON.stringify(built.envelope, null, 2)}\n`;
  if (Buffer.byteLength(json, 'utf8') > SHARED_SESSION_MAX_BYTES) {
    return { ok: false, message: 'This session is too large to share as a file.' };
  }
  const title = built.envelope.detail.summary.title;
  return {
    ok: true,
    json,
    turns: built.envelope.detail.turns.length,
    redactions: built.envelope.redactions.count,
    kinds: built.envelope.redactions.kinds,
    ...(title !== undefined ? { title } : {}),
  };
}

/** What the file would hold, without writing it. */
export function previewShare(input: ShareSessionInput): SharePreview {
  const built = build(input);
  if (!built.ok) {
    return built;
  }
  return {
    ok: true,
    bytes: Buffer.byteLength(built.json, 'utf8'),
    turns: built.turns,
    redactions: built.redactions,
    redactionKinds: built.kinds,
    ...(built.title !== undefined ? { title: built.title } : {}),
  };
}

type WriteFs = Pick<typeof fs, 'writeFileSync' | 'renameSync' | 'rmSync' | 'mkdirSync'>;

/**
 * Write the file to the path the user chose. The path must carry the
 * shared-session extension: the save dialog proposes it, and a call that
 * names anything else is refused rather than writing over an arbitrary file.
 */
export function exportShare(input: ShareSessionInput, filePath: string, io: WriteFs = fs): ShareExportResult {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !filePath.toLowerCase().endsWith(SHARED_SESSION_EXTENSION)) {
    return { ok: false, message: `The file name must end in ${SHARED_SESSION_EXTENSION}.` };
  }
  const built = build(input);
  if (!built.ok) {
    return built;
  }
  try {
    writeAtomically(filePath, built.json, io);
  } catch (err) {
    return { ok: false, message: `Could not write the file: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, path: filePath, bytes: Buffer.byteLength(built.json, 'utf8') };
}

type ReadFs = Pick<typeof fs, 'statSync' | 'readFileSync' | 'existsSync'>;

/**
 * Validate a shared-session file and keep a copy under {@link resolveSharedDir}.
 * What is stored is the validated value re-serialized, not the bytes read, so
 * the copy holds exactly the fields the format allows.
 */
export function importShare(
  filePath: string,
  sharedDir: string,
  io: ReadFs & WriteFs = fs,
): ShareImportResult {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !filePath.toLowerCase().endsWith('.json')) {
    return { ok: false, problems: ['Choose a shared-session file (.aosession.json).'] };
  }
  let size: number;
  try {
    const stat = io.statSync(filePath);
    if (!stat.isFile()) {
      return { ok: false, problems: ['That is not a file.'] };
    }
    size = stat.size;
  } catch {
    return { ok: false, problems: ['The file could not be found.'] };
  }
  if (size > SHARED_SESSION_MAX_BYTES) {
    return { ok: false, problems: [`The file is larger than ${SHARED_SESSION_MAX_BYTES / (1024 * 1024)} MB, the most a shared session may be.`] };
  }
  let text: string;
  try {
    text = io.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { ok: false, problems: [`The file could not be read: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const parsed = parseSharedSession(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  if (!parsed.ok) {
    return parsed;
  }
  const id = sharedSessionId(parsed.envelope);
  const target = path.join(sharedDir, `${id}.json`);
  const replaced = io.existsSync(target);
  try {
    io.mkdirSync(sharedDir, { recursive: true });
    writeAtomically(target, `${JSON.stringify(parsed.envelope)}\n`, io);
  } catch (err) {
    return { ok: false, problems: [`The session could not be stored: ${err instanceof Error ? err.message : String(err)}`] };
  }
  return { ok: true, source: SHARED_SOURCE_ID, sessionId: id, replaced };
}

/** Remove the app's own copy of an imported session. */
export function removeShared(file: string, io: Pick<typeof fs, 'rmSync'> = fs): { ok: boolean; detail: string } {
  try {
    io.rmSync(file, { force: true });
    return { ok: true, detail: 'Removed the imported copy.' };
  } catch (err) {
    return { ok: false, detail: `Could not remove ${file}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function writeAtomically(target: string, content: string, io: WriteFs): void {
  const temp = `${target}.${process.pid}.tmp`;
  try {
    io.writeFileSync(temp, content, 'utf8');
    io.renameSync(temp, target);
  } catch (err) {
    try {
      io.rmSync(temp, { force: true });
    } catch {
      // Nothing more to clean up.
    }
    throw err;
  }
}
