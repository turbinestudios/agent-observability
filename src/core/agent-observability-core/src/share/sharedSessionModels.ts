import type { AgentSourceId, CostMode, SessionDetail } from '../telemetry/models';
import type { RedactionKind } from '../text/redact';

/**
 * A shared session: ONE session a user chose to export to a file so a
 * colleague can import it and compare it with their own.
 *
 * Unlike the team shard, this file carries raw content: the prompts, the
 * assistant's final responses, the tool names and every figure the detail
 * view shows. That is the point of it, and it is why it exists only as a
 * file the user writes after a dialog stating exactly that, with
 * best-effort secret redaction applied first. The app never sends it
 * anywhere; the user does.
 *
 * Deliberately NOT in the file: tags, notes, hidden flags, the user's
 * pseudonymous id or salt, a rename history, external URLs, tool inputs and
 * file paths (the detail model never holds them), the context analysis and
 * the retrospective (the receiver derives its own from the detail).
 *
 * Keep these types in lockstep with `schemas/shared-session.schema.json`,
 * which is generated from `sharedSessionShape.ts` and checked by a test.
 */

export const SHARED_SESSION_KIND = 'agent-observability.shared-session';
export const SHARED_SESSION_SCHEMA_VERSION = '1.0';

/** Files larger than this are refused before parsing, on export and on import. */
export const SHARED_SESSION_MAX_BYTES = 50 * 1024 * 1024;

/** The extension the save dialog proposes. Import also accepts plain `.json`. */
export const SHARED_SESSION_EXTENSION = '.aosession.json';

/** The source id imported sessions are listed under. */
export const SHARED_SOURCE_ID = 'shared' as const;

/** Sources a shared file may say it came from: every real source, never `shared`. */
export const SHAREABLE_SOURCES = [
  'claude',
  'copilot',
  'copilot-cloud',
  'copilot-agent',
  'copilot-cli',
  'copilot-app',
  'copilot-jetbrains',
  'opencode',
] as const satisfies readonly AgentSourceId[];
export type ShareableSource = (typeof SHAREABLE_SOURCES)[number];

export const SHARED_COST_MODES = ['aiu', 'usd', 'credits'] as const satisfies readonly CostMode[];

export const SHARED_REDACTION_KINDS = [
  'token',
  'authorization',
  'env-assignment',
  'private-key',
  'url-credentials',
] as const satisfies readonly RedactionKind[];

export interface SharedSessionEnvelope {
  kind: typeof SHARED_SESSION_KIND;
  schemaVersion: typeof SHARED_SESSION_SCHEMA_VERSION;
  /** When the file was written, epoch ms. */
  exportedAtMs: number;
  /** The exporting app's version. */
  toolVersion: string;
  origin: {
    /** The source that recorded the session. */
    source: ShareableSource;
    /** Its cost basis, so the receiver prices the session as the sender saw it. */
    costMode: CostMode;
  };
  /** What the redaction pass replaced before writing. */
  redactions: { count: number; kinds: RedactionKind[] };
  detail: SessionDetail;
}
