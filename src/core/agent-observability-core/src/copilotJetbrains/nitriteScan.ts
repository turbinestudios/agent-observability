/**
 * A tolerant, read-only reader for the Copilot JetBrains plugin's chat store.
 *
 * The store is an H2 MVStore file (header `H:2,block:…,format:…`) of
 * Java-serialized Nitrite documents. There is no Node parser for either
 * layer, so this does not parse pages. It does what codeburn's provider does
 * (github.com/getagentseal/codeburn, docs/providers/copilot.md, MIT): find
 * the Java strings in the bytes, and read the documents' shape from the
 * record names and keys around them:
 *
 * - a conversation is a GUID followed by its `title` (the title changes over
 *   time; the last one read wins), with `projectName` from plugin 1.12;
 * - in agent and plan mode the reply is an `AgentRound` record's `reply` and
 *   the user prompt a `Markdown` record's `text`; in ask mode the reply is a
 *   `Markdown` `text`;
 * - `Thinking`, `PendingChanges`, `AskQuestion`, `Notification` and
 *   `SubTurn` are side records and are never read as turns;
 * - no token counts or billed usage are stored at all.
 *
 * NOT VERIFIED ON DISK: written without a JetBrains IDE to test against.
 * Every field is optional, nothing is guessed, and a file the scanner cannot
 * make sense of yields no sessions and a non-zero `unreadable` in the stats
 * rather than an error. MVStore keeps superseded page versions, so the same
 * turn can occur more than once; turns are de-duplicated.
 */

export type JetbrainsTurnMode = 'agent' | 'ask';

export interface JetbrainsTurn {
  prompt?: string;
  reply?: string;
  mode: JetbrainsTurnMode;
  model?: string;
  timestampMs?: number;
}

export interface JetbrainsConversation {
  /** The conversation GUID, lower case; absent for the legacy single-document layout. */
  id?: string;
  title?: string;
  projectName?: string;
  /** `file://` URIs the chat referenced, for finding the repository. */
  fileUris: string[];
  turns: JetbrainsTurn[];
}

export interface JetbrainsScanStats {
  /** The file starts with the MVStore header. */
  mvstoreHeader: boolean;
  strings: number;
  markers: Record<string, number>;
  conversations: number;
  turns: number;
  models: number;
}

export interface JetbrainsScan {
  conversations: JetbrainsConversation[];
  /** The most common model in the store, for turns that name none. */
  defaultModel?: string;
  stats: JetbrainsScanStats;
}

export interface JavaString {
  /** Offset of the type tag. */
  start: number;
  /** Offset just past the string's bytes. */
  end: number;
  value: string;
  /** `class` for a class-descriptor name, `string` for a string value. */
  kind: 'string' | 'class';
}

const TC_CLASSDESC = 0x72;
const TC_STRING = 0x74;
const TC_LONGSTRING = 0x7c;
const MAX_LONG_STRING = 16 * 1024 * 1024;

/**
 * Java's modified UTF-8 (NUL as `C0 80`, supplementary characters as
 * surrogate pairs). `undefined` when the bytes are not well formed.
 */
export function decodeModifiedUtf8(bytes: Uint8Array): string | undefined {
  const units: number[] = [];
  for (let i = 0; i < bytes.length; ) {
    const a = bytes[i];
    if (a < 0x80) {
      if (a === 0) {
        return undefined;
      }
      units.push(a);
      i += 1;
    } else if ((a & 0xe0) === 0xc0) {
      const b = bytes[i + 1];
      if (b === undefined || (b & 0xc0) !== 0x80) {
        return undefined;
      }
      units.push(((a & 0x1f) << 6) | (b & 0x3f));
      i += 2;
    } else if ((a & 0xf0) === 0xe0) {
      const b = bytes[i + 1];
      const c = bytes[i + 2];
      if (b === undefined || c === undefined || (b & 0xc0) !== 0x80 || (c & 0xc0) !== 0x80) {
        return undefined;
      }
      units.push(((a & 0x0f) << 12) | ((b & 0x3f) << 6) | (c & 0x3f));
      i += 3;
    } else if ((a & 0xf8) === 0xf0) {
      // Standard 4-byte UTF-8: not what Java writes, but harmless to accept.
      const rest = [bytes[i + 1], bytes[i + 2], bytes[i + 3]];
      if (rest.some((x) => x === undefined || (x & 0xc0) !== 0x80)) {
        return undefined;
      }
      const cp = ((a & 0x07) << 18) | ((rest[0] & 0x3f) << 12) | ((rest[1] & 0x3f) << 6) | (rest[2] & 0x3f);
      const v = cp - 0x10000;
      units.push(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
      i += 4;
    } else {
      return undefined;
    }
  }
  let out = '';
  for (let i = 0; i < units.length; i += 8192) {
    out += String.fromCharCode(...units.slice(i, i + 8192));
  }
  return out;
}

/** Text a person or model wrote: no control characters other than whitespace. */
function plausibleText(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return value.length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/.test(value);
}

const CLASS_NAME = /^[A-Za-z_$][\w$.]*(?:\[\])*$|^\[+[A-Za-z][\w$.;/]*$/;

/** Every Java string and class name in the bytes, in file order. */
export function extractJavaStrings(buf: Uint8Array): JavaString[] {
  const out: JavaString[] = [];
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i + 3 <= buf.length; ) {
    const tag = buf[i];
    if (tag === TC_STRING || tag === TC_CLASSDESC) {
      const len = view.getUint16(i + 1);
      const end = i + 3 + len;
      if (len > 0 && end <= buf.length) {
        const value = decodeModifiedUtf8(buf.subarray(i + 3, end));
        if (value !== undefined) {
          if (tag === TC_STRING && plausibleText(value)) {
            out.push({ start: i, end, value, kind: 'string' });
            i = end;
            continue;
          }
          if (tag === TC_CLASSDESC && CLASS_NAME.test(value)) {
            out.push({ start: i, end, value, kind: 'class' });
            i = end;
            continue;
          }
        }
      }
    } else if (tag === TC_LONGSTRING && i + 9 <= buf.length) {
      const high = view.getUint32(i + 1);
      const len = view.getUint32(i + 5);
      const end = i + 9 + len;
      if (high === 0 && len > 0 && len <= MAX_LONG_STRING && end <= buf.length) {
        const value = decodeModifiedUtf8(buf.subarray(i + 9, end));
        if (value !== undefined && plausibleText(value)) {
          out.push({ start: i, end, value, kind: 'string' });
          i = end;
          continue;
        }
      }
    }
    i += 1;
  }
  return out;
}

const TURN_MARKERS = ['NtAgentTurn', '__first__'] as const;
const SESSION_MARKERS = ['NtAgentSession'] as const;
const REPLY_RECORD = 'AgentRound';
const TEXT_RECORD = 'Markdown';
const SIDE_RECORDS = ['Thinking', 'PendingChanges', 'AskQuestion', 'Notification', 'SubTurn'] as const;
const ALL_MARKERS = [...TURN_MARKERS, ...SESSION_MARKERS, REPLY_RECORD, TEXT_RECORD, ...SIDE_RECORDS];

const KEYS = new Set([
  'text',
  'reply',
  'title',
  'projectName',
  'model',
  'modelName',
  'modelId',
  'conversationId',
  'sessionId',
  'createdAt',
  'updatedAt',
  'timestamp',
  'createdDate',
  'type',
]);
const MODEL_KEYS = new Set(['model', 'modelName', 'modelId']);
const TIME_KEYS = new Set(['createdAt', 'updatedAt', 'timestamp', 'createdDate']);
const ID_KEYS = new Set(['conversationId', 'sessionId']);

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODEL_ID = /^(?:gpt|claude|o\d|gemini|grok|mai|raptor|oswe)[\w.:-]{0,60}$/i;
/** Key and value sit this close: the value's tag follows the key's bytes, give or take an object header. */
const PAIR_GAP = 32;
/** A conversation's GUID is read only when its title follows within this many strings. */
const TITLE_LOOKAHEAD = 8;

/** Epoch milliseconds between 2023-01-01 and a day from now. */
function plausibleMs(ms: number, nowMs: number): boolean {
  return ms >= 1_672_531_200_000 && ms <= nowMs + 86_400_000;
}

function markerOf(s: JavaString): string | undefined {
  for (const marker of ALL_MARKERS) {
    if (s.value === marker || s.value.endsWith(`.${marker}`) || s.value.endsWith(`$${marker}`)) {
      return marker;
    }
  }
  return undefined;
}

function parseTime(value: string, nowMs: number): number | undefined {
  if (/^\d{12,14}$/.test(value)) {
    const ms = Number(value);
    return plausibleMs(ms, nowMs) ? ms : undefined;
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) && plausibleMs(ms, nowMs) ? ms : undefined;
  }
  return undefined;
}

interface DraftTurn {
  start: number;
  end: number;
  texts: string[];
  replies: string[];
  model?: string;
  timestampMs?: number;
}

interface DraftConversation {
  id?: string;
  title?: string;
  projectName?: string;
  fileUris: Set<string>;
  turns: DraftTurn[];
}

/** Scan one store's bytes. Never throws for malformed input. */
export function scanNitriteStore(buf: Uint8Array, nowMs: number = Date.now()): JetbrainsScan {
  const header = Buffer.from(buf.subarray(0, 16)).toString('latin1');
  const strings = extractJavaStrings(buf);
  const markers: Record<string, number> = {};
  const conversations = new Map<string, DraftConversation>();
  const legacy: DraftConversation = { fileUris: new Set(), turns: [] };
  const modelCounts = new Map<string, number>();
  let current: DraftConversation = legacy;
  let turn: DraftTurn | undefined;
  let record: 'reply' | 'text' | 'side' | undefined;
  let pendingIdKey = false;

  const startTurn = (at: number): DraftTurn => {
    if (turn !== undefined) {
      turn.end = at;
    }
    turn = { start: at, end: buf.length, texts: [], replies: [] };
    current.turns.push(turn);
    return turn;
  };
  const conversation = (id: string): DraftConversation => {
    const key = id.toLowerCase();
    let found = conversations.get(key);
    if (found === undefined) {
      found = { id: key, fileUris: new Set(), turns: [] };
      conversations.set(key, found);
    }
    return found;
  };

  for (let i = 0; i < strings.length; i += 1) {
    const s = strings[i];
    const marker = markerOf(s);
    if (marker !== undefined) {
      markers[marker] = (markers[marker] ?? 0) + 1;
      if ((TURN_MARKERS as readonly string[]).includes(marker)) {
        startTurn(s.start);
        record = undefined;
      } else if (marker === REPLY_RECORD) {
        record = 'reply';
      } else if (marker === TEXT_RECORD) {
        record = 'text';
      } else if ((SIDE_RECORDS as readonly string[]).includes(marker)) {
        record = 'side';
      }
      continue;
    }
    if (s.kind !== 'string') {
      continue;
    }
    if (GUID.test(s.value)) {
      const named = strings
        .slice(i + 1, i + 1 + TITLE_LOOKAHEAD)
        .some((next) => next.kind === 'string' && next.value === 'title');
      if (pendingIdKey || named) {
        if (turn !== undefined) {
          turn.end = s.start;
        }
        current = conversation(s.value);
        turn = undefined;
        record = undefined;
      }
      pendingIdKey = false;
      continue;
    }
    pendingIdKey = false;
    if (s.value.startsWith('file://')) {
      current.fileUris.add(s.value);
      continue;
    }
    if (MODEL_ID.test(s.value)) {
      modelCounts.set(s.value, (modelCounts.get(s.value) ?? 0) + 1);
      if (turn !== undefined) {
        turn.model ??= s.value;
      }
    }
    if (!KEYS.has(s.value)) {
      continue;
    }
    if (ID_KEYS.has(s.value)) {
      pendingIdKey = true;
      continue;
    }
    const next = strings[i + 1];
    if (next === undefined || next.kind !== 'string' || next.start - s.end > PAIR_GAP || markerOf(next) !== undefined) {
      continue;
    }
    const key = s.value;
    const value = next.value;
    i += 1;
    if (key === 'title') {
      current.title = value;
    } else if (key === 'projectName') {
      current.projectName = value;
    } else if (MODEL_KEYS.has(key)) {
      if (MODEL_ID.test(value)) {
        modelCounts.set(value, (modelCounts.get(value) ?? 0) + 1);
      }
      if (turn !== undefined) {
        turn.model = value;
      }
    } else if (TIME_KEYS.has(key)) {
      const ms = parseTime(value, nowMs);
      if (ms !== undefined && turn !== undefined) {
        turn.timestampMs ??= ms;
      }
    } else if (key === 'text' && record === 'text') {
      // A new prompt after a reply opens the next turn when no turn marker did.
      const t = turn ?? startTurn(s.start);
      if (t.replies.length > 0) {
        startTurn(s.start).texts.push(value);
      } else {
        t.texts.push(value);
      }
    } else if (key === 'reply' && record === 'reply') {
      (turn ?? startTurn(s.start)).replies.push(value);
    }
  }

  const draft = [...conversations.values(), ...(legacy.turns.length > 0 ? [legacy] : [])];
  const defaultModel = [...modelCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  const out: JetbrainsConversation[] = [];
  let turnCount = 0;
  for (const conv of draft) {
    const turns = finishTurns(conv.turns, buf, nowMs);
    if (turns.length === 0) {
      continue;
    }
    turnCount += turns.length;
    out.push({
      ...(conv.id !== undefined ? { id: conv.id } : {}),
      ...(conv.title !== undefined ? { title: conv.title } : {}),
      ...(conv.projectName !== undefined ? { projectName: conv.projectName } : {}),
      fileUris: [...conv.fileUris],
      turns,
    });
  }
  return {
    conversations: out,
    ...(defaultModel !== undefined ? { defaultModel } : {}),
    stats: {
      mvstoreHeader: header.startsWith('H:2'),
      strings: strings.length,
      markers,
      conversations: out.length,
      turns: turnCount,
      models: modelCounts.size,
    },
  };
}

/**
 * Shapes draft turns, finds a timestamp where no key gave one, and removes
 * the copies MVStore's superseded pages leave behind (identical turns, and a
 * reply that is a prefix of a longer one for the same prompt: a page written
 * mid-stream).
 */
function finishTurns(drafts: readonly DraftTurn[], buf: Uint8Array, nowMs: number): JetbrainsTurn[] {
  const shaped: JetbrainsTurn[] = [];
  for (const d of drafts) {
    const agent = d.replies.length > 0;
    const prompt = agent ? d.texts[0] : d.texts.length >= 2 ? d.texts[0] : undefined;
    const reply = agent ? d.replies.join('\n\n') : d.texts.length >= 2 ? d.texts.slice(1).join('\n\n') : d.texts[0];
    if (prompt === undefined && reply === undefined) {
      continue;
    }
    const timestampMs = d.timestampMs ?? longTimestampIn(buf, d.start, d.end, nowMs);
    shaped.push({
      mode: agent ? 'agent' : 'ask',
      ...(prompt !== undefined ? { prompt } : {}),
      ...(reply !== undefined ? { reply } : {}),
      ...(d.model !== undefined ? { model: d.model } : {}),
      ...(timestampMs !== undefined ? { timestampMs } : {}),
    });
  }
  const kept: JetbrainsTurn[] = [];
  for (const t of shaped) {
    const twin = kept.findIndex(
      (k) =>
        k.prompt === t.prompt &&
        (k.reply === t.reply ||
          (k.reply !== undefined && t.reply !== undefined && (k.reply.startsWith(t.reply) || t.reply.startsWith(k.reply)))),
    );
    if (twin === -1) {
      kept.push(t);
    } else if ((t.reply?.length ?? 0) > (kept[twin].reply?.length ?? 0)) {
      kept[twin] = { ...t, timestampMs: kept[twin].timestampMs ?? t.timestampMs } as JetbrainsTurn;
    }
  }
  // File order is the fallback; time order only when every turn has a time.
  return kept.every((t) => t.timestampMs !== undefined)
    ? kept.sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0))
    : kept;
}

/**
 * The first big-endian 8-byte epoch-ms value in a byte range: how a Java
 * `long` or `Long` field is serialized. Plausible values in the scan window
 * all start `00 00 01`, which keeps false hits rare.
 */
function longTimestampIn(buf: Uint8Array, start: number, end: number, nowMs: number): number | undefined {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const stop = Math.min(end, buf.length) - 8;
  for (let i = Math.max(0, start); i <= stop; i += 1) {
    if (buf[i] !== 0 || buf[i + 1] !== 0 || buf[i + 2] !== 1) {
      continue;
    }
    const ms = view.getUint32(i) * 2 ** 32 + view.getUint32(i + 4);
    if (plausibleMs(ms, nowMs)) {
      return ms;
    }
  }
  return undefined;
}
