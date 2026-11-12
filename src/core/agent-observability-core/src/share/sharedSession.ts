import { createHash } from 'node:crypto';
import type { SessionContextAnalysis } from '../context/models';
import type { CostMode, SessionDetail, SessionTimelineEntry, SessionTurn } from '../telemetry/models';
import { redactSecrets, type RedactionKind } from '../text/redact';
import { isObject, schemaVersionOf } from '../aggregate/batchValidators';
import {
  SHARED_SESSION_KIND,
  SHARED_SESSION_READABLE_VERSIONS,
  SHARED_SESSION_SCHEMA_VERSION,
  SHARED_SOURCE_ID,
  SHAREABLE_SOURCES,
  type ShareableSource,
  type SharedSessionEnvelope,
} from './sharedSessionModels';
import { importedContext, shareableContext } from './sharedContext';
import {
  SESSION_DETAIL_SHAPE,
  SHARED_CONTEXT_SHAPE,
  SHARED_SESSION_SHAPE,
  pickShape,
  validateShape,
} from './sharedSessionShape';

/**
 * Building a shared-session file on export, and checking one on import.
 * Pure: no file system, so the data host owns every read and write.
 */

export interface BuildSharedSessionInput {
  detail: SessionDetail;
  source: string;
  costMode: CostMode;
  /** The name the user sees, a rename included; replaces the source's own title. */
  title?: string;
  toolVersion: string;
  nowMs: number;
  /** The session's Context Analysis as this machine computed it; exported without absolute paths. */
  context?: SessionContextAnalysis;
  /** The repository root a context file sits in, for its repository-relative path. Without it, files keep their names only. */
  repoRootOf?: (filePath: string) => string | undefined;
}

export type BuildSharedSessionResult =
  | { ok: true; envelope: SharedSessionEnvelope }
  | { ok: false; message: string };

/** Whether a source's sessions may be exported. An imported session never is. */
export function isShareableSource(source: string): source is ShareableSource {
  return (SHAREABLE_SOURCES as readonly string[]).includes(source);
}

/**
 * The envelope for one session: the detail copied through the shape's
 * allowlist, every free-text field run through {@link redactSecrets}, and
 * the result validated exactly as an importer would validate it, so the app
 * can never write a file it would itself refuse.
 */
export function buildSharedSession(input: BuildSharedSessionInput): BuildSharedSessionResult {
  if (!isShareableSource(input.source)) {
    return { ok: false, message: 'A session imported from someone else cannot be shared again.' };
  }
  const picked = pickShape(input.detail, SESSION_DETAIL_SHAPE) as SessionDetail;
  const tally = new Tally();
  const title = input.title ?? picked.summary.title;
  const summary = { ...picked.summary };
  if (title !== undefined && title.length > 0) {
    summary.title = tally.redact(title);
    summary.titleDerived = input.title !== undefined ? false : summary.titleDerived;
  }
  const detail: SessionDetail = {
    ...picked,
    summary,
    turns: picked.turns.map((turn) => redactTurn(turn, tally)),
  };
  const context =
    input.context !== undefined
      ? (pickShape(
          shareableContext(input.context, {
            redact: (text) => tally.redact(text),
            ...(input.repoRootOf !== undefined ? { repoRootOf: input.repoRootOf } : {}),
          }),
          SHARED_CONTEXT_SHAPE,
        ) as SessionContextAnalysis)
      : undefined;
  const envelope: SharedSessionEnvelope = {
    kind: SHARED_SESSION_KIND,
    schemaVersion: SHARED_SESSION_SCHEMA_VERSION,
    exportedAtMs: input.nowMs,
    toolVersion: input.toolVersion,
    origin: { source: input.source, costMode: input.costMode },
    redactions: { count: tally.count, kinds: tally.kinds },
    detail,
    ...(context !== undefined ? { contextAnalysis: context } : {}),
  };
  const errors = validateShape(envelope, SHARED_SESSION_SHAPE);
  if (errors.length > 0) {
    return { ok: false, message: `This session could not be packaged: ${errors[0]}` };
  }
  return { ok: true, envelope };
}

class Tally {
  count = 0;
  kinds: RedactionKind[] = [];

  redact(text: string): string {
    const result = redactSecrets(text);
    this.count += result.redactions;
    for (const kind of result.kinds) {
      if (!this.kinds.includes(kind)) {
        this.kinds.push(kind);
      }
    }
    return result.text;
  }
}

function redactTurn(turn: SessionTurn, tally: Tally): SessionTurn {
  return {
    ...turn,
    ...(turn.userRequest !== undefined ? { userRequest: tally.redact(turn.userRequest) } : {}),
    ...(turn.finalResponse !== undefined ? { finalResponse: tally.redact(turn.finalResponse) } : {}),
    events: turn.events.map((event): SessionTimelineEntry =>
      event.userRequest !== undefined ? { ...event, userRequest: tally.redact(event.userRequest) } : event,
    ),
  };
}

/** An object whose `schemaVersion` is a string other than the ones we read. */
export function isUnknownSharedSessionVersion(value: unknown): boolean {
  const version = schemaVersionOf(value);
  return version !== undefined && !(SHARED_SESSION_READABLE_VERSIONS as readonly string[]).includes(version);
}

/**
 * `[]` when `value` is a shared-session file this app can import; otherwise
 * one message per problem. A newer format is named as such, so the user
 * knows to update rather than suspecting the file.
 */
export function validateSharedSession(value: unknown): string[] {
  if (!isObject(value)) {
    return ['The file is not a shared session.'];
  }
  if (value.kind !== SHARED_SESSION_KIND) {
    return ['The file is not a shared session exported by Agent Observability.'];
  }
  if (isUnknownSharedSessionVersion(value)) {
    return [
      `The file uses shared-session format ${String(value.schemaVersion)}, which this version of the app cannot read. Update the app and try again.`,
    ];
  }
  return validateShape(value, SHARED_SESSION_SHAPE);
}

/** Parse and validate file text. */
export function parseSharedSession(
  text: string,
): { ok: true; envelope: SharedSessionEnvelope } | { ok: false; problems: string[] } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, problems: ['The file is not valid JSON.'] };
  }
  const problems = validateSharedSession(value);
  return problems.length === 0 ? { ok: true, envelope: value as SharedSessionEnvelope } : { ok: false, problems };
}

/** `<origin source>.<16 hex>`: what an imported session is keyed by. */
export const SHARED_SESSION_ID_PATTERN = /^[a-z][a-z-]{0,31}\.[0-9a-f]{16}$/;

/**
 * The id an imported session is listed under. Derived from where it came
 * from and its original id, so importing the same session again (say, an
 * updated export) replaces the earlier copy instead of listing it twice.
 */
export function sharedSessionId(envelope: Pick<SharedSessionEnvelope, 'origin' | 'detail'>): string {
  const hash = createHash('sha256')
    .update(`${envelope.origin.source}\0${envelope.detail.summary.sessionId}`)
    .digest('hex')
    .slice(0, 16);
  return `${envelope.origin.source}.${hash}`;
}

/**
 * The detail as the receiving app serves it: keyed by its imported id, under
 * the `shared` source.
 */
export function importedDetail(envelope: SharedSessionEnvelope, id: string): SessionDetail {
  return {
    ...envelope.detail,
    summary: { ...envelope.detail.summary, sessionId: id, source: SHARED_SOURCE_ID },
  };
}

/** The Context Analysis an imported file carries, captioned as the sender's; `undefined` when it has none. */
export function importedContextAnalysis(envelope: SharedSessionEnvelope): SessionContextAnalysis | undefined {
  return envelope.contextAnalysis !== undefined ? importedContext(envelope.contextAnalysis) : undefined;
}
