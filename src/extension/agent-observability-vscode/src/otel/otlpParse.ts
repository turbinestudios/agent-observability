/**
 * Minimal, defensive parser for the OpenTelemetry JSON that the GitHub Copilot
 * Chat "file" exporter writes (`github.copilot.chat.otel.exporterType = "file"`,
 * path = `github.copilot.chat.otel.outfile`).
 *
 * We deliberately do NOT assume a single line framing. Each tailed line is parsed
 * as JSON and may be any of:
 *   - a full OTLP export envelope `{ "resourceSpans": [ ... ] }`
 *   - a bare `ResourceSpans` `{ "resource": ..., "scopeSpans": [ ... ] }`
 *   - a `ScopeSpans` `{ "spans": [ ... ] }`
 *   - a single span object `{ "name": ..., "attributes": [ ... ] }`
 * {@link flattenSpans} normalizes all of these into a flat list of spans paired
 * with their owning resource attributes.
 *
 * OTLP/JSON encodes attribute values as "AnyValue" objects
 * (`{ stringValue | intValue | doubleValue | boolValue | ... }`) and int64 as a
 * STRING; {@link decodeAnyValue} tolerates ints arriving as either form. Unknown
 * keys are ignored, so a Copilot version that adds attributes never breaks
 * parsing.
 *
 * Attribute keys follow the OTel GenAI semantic conventions (`gen_ai.*`) plus
 * Copilot's `copilot_chat.*`; the subset used here was verified against a
 * captured Agent Debug Logs export. This module is PURE (no `vscode`, no `fs`)
 * so it is unit-tested headless.
 */

/** OTLP attribute primitive after decoding the AnyValue wrapper. */
export type AttrValue = string | number | boolean;

/** A normalized span: only the fields the live view needs. */
export interface OtlpSpan {
  name: string;
  attributes: Map<string, AttrValue>;
  startUnixNano?: string;
  endUnixNano?: string;
  traceId?: string;
  spanId?: string;
}

/** A span paired with its owning resource's (decoded) attributes. */
export interface FlatSpan {
  span: OtlpSpan;
  resource: Map<string, AttrValue>;
}

/** Live-relevant fields projected from a single span. */
export interface LiveFields {
  /** All ids this span could be keyed by, most-specific first. */
  candidateIds: string[];
  /** `gen_ai.operation.name`: chat | execute_tool | execute_hook | core_event | … */
  operation?: string;
  spanName: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  toolName?: string;
  /** Turn index from `turn_start:N` / `turn_end:N`, or `copilot_chat.turn_count`. */
  turn?: number;
  /** Friendly sub-agent name from a `runSubagent[-<Name>]` span. */
  subagentName?: string;
  timestampMs?: number;
}

/**
 * Resource/span attribute keys that can carry a session identity. Ordered
 * most-specific first; the extension keys panels by
 * `COALESCE(conversation_id, chat_session_id)`, so we collect every candidate
 * and let the router match against whatever the open panel is keyed by.
 */
const ID_ATTR_KEYS = ['gen_ai.conversation.id', 'conversation_id', 'chat_session_id'] as const;

/** Decode an OTLP/JSON "AnyValue" wrapper to a primitive, or `undefined`. */
function decodeAnyValue(value: unknown): AttrValue | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }
  const v = value as Record<string, unknown>;
  if (typeof v.stringValue === 'string') {
    return v.stringValue;
  }
  if (typeof v.boolValue === 'boolean') {
    return v.boolValue;
  }
  // int64 is serialized as a string in OTLP/JSON; accept both forms.
  if (typeof v.intValue === 'number') {
    return v.intValue;
  }
  if (typeof v.intValue === 'string') {
    const n = Number(v.intValue);
    return Number.isFinite(n) ? n : undefined;
  }
  if (typeof v.doubleValue === 'number') {
    return v.doubleValue;
  }
  if (typeof v.doubleValue === 'string') {
    const n = Number(v.doubleValue);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined; // arrayValue / kvlistValue are not needed for the live view.
}

/** Decode an OTLP attributes array (`[{ key, value }]`) into a Map. */
function decodeAttributes(attrs: unknown): Map<string, AttrValue> {
  const out = new Map<string, AttrValue>();
  if (!Array.isArray(attrs)) {
    return out;
  }
  for (const entry of attrs) {
    if (entry === null || typeof entry !== 'object') {
      continue;
    }
    const key = (entry as { key?: unknown }).key;
    if (typeof key !== 'string') {
      continue;
    }
    const decoded = decodeAnyValue((entry as { value?: unknown }).value);
    if (decoded !== undefined) {
      out.set(key, decoded);
    }
  }
  return out;
}

function pushSpan(out: FlatSpan[], raw: unknown, resource: Map<string, AttrValue>): void {
  if (raw === null || typeof raw !== 'object') {
    return;
  }
  const s = raw as Record<string, unknown>;
  out.push({
    span: {
      name: typeof s.name === 'string' ? s.name : '',
      attributes: decodeAttributes(s.attributes),
      startUnixNano: typeof s.startTimeUnixNano === 'string' ? s.startTimeUnixNano : undefined,
      endUnixNano: typeof s.endTimeUnixNano === 'string' ? s.endTimeUnixNano : undefined,
      traceId: typeof s.traceId === 'string' ? s.traceId : undefined,
      spanId: typeof s.spanId === 'string' ? s.spanId : undefined,
    },
    resource,
  });
}

/**
 * Normalize any of the supported OTLP shapes into a flat list of spans, each
 * carrying its owning resource attributes. Tolerant of partial/unknown shapes:
 * anything unrecognized yields `[]`.
 */
export function flattenSpans(parsed: unknown): FlatSpan[] {
  const out: FlatSpan[] = [];
  if (parsed === null || typeof parsed !== 'object') {
    return out;
  }
  const root = parsed as Record<string, unknown>;

  const resourceSpans = Array.isArray(root.resourceSpans)
    ? root.resourceSpans
    : root.resource !== undefined || root.scopeSpans !== undefined
      ? [root] // a single bare ResourceSpans
      : undefined;

  if (resourceSpans !== undefined) {
    for (const rs of resourceSpans) {
      if (rs === null || typeof rs !== 'object') {
        continue;
      }
      const r = rs as Record<string, unknown>;
      const resourceAttrs = decodeAttributes(
        (r.resource as { attributes?: unknown } | undefined)?.attributes,
      );
      const scopeSpans = Array.isArray(r.scopeSpans)
        ? r.scopeSpans
        : Array.isArray(r.instrumentationLibrarySpans)
          ? r.instrumentationLibrarySpans // legacy OTLP name
          : [];
      for (const ss of scopeSpans) {
        const spans = (ss as { spans?: unknown } | null)?.spans;
        if (!Array.isArray(spans)) {
          continue;
        }
        for (const sp of spans) {
          pushSpan(out, sp, resourceAttrs);
        }
      }
    }
    return out;
  }

  // A bare ScopeSpans: `{ spans: [...] }`.
  if (Array.isArray(root.spans)) {
    for (const sp of root.spans) {
      pushSpan(out, sp, new Map());
    }
    return out;
  }

  // A single bare span object.
  if (typeof root.name === 'string' || typeof root.spanId === 'string') {
    pushSpan(out, root, new Map());
  }
  return out;
}

/** Parse one JSON-lines line into flattened spans; never throws. */
export function parseLine(line: string): FlatSpan[] {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return []; // partial/garbled line — the tailer re-buffers; skip for now.
  }
  return flattenSpans(parsed);
}

function strAttr(attrs: Map<string, AttrValue>, key: string): string | undefined {
  const v = attrs.get(key);
  return typeof v === 'string' ? v : undefined;
}

function numAttr(attrs: Map<string, AttrValue>, key: string): number {
  const v = attrs.get(key);
  return typeof v === 'number' ? v : 0;
}

/** Nanosecond epoch string → integer ms, or `undefined` when unparseable. */
function nanoToMs(nano?: string): number | undefined {
  if (typeof nano !== 'string' || nano.length === 0) {
    return undefined;
  }
  const n = Number(nano);
  return Number.isFinite(n) ? Math.floor(n / 1e6) : undefined;
}

/** Project the live-relevant fields out of one flattened span. */
export function extractLiveFields(flat: FlatSpan): LiveFields {
  const { span, resource } = flat;
  const a = span.attributes;

  const candidateIds: string[] = [];
  const pushId = (v: AttrValue | undefined): void => {
    if (typeof v === 'string' && v.length > 0 && !candidateIds.includes(v)) {
      candidateIds.push(v);
    }
  };
  // Span-level ids are more specific than the resource session id; collect both.
  for (const key of ID_ATTR_KEYS) {
    pushId(a.get(key));
  }
  pushId(resource.get('session.id'));
  pushId(span.traceId); // last resort so a session is never wholly unkeyed.

  let turn: number | undefined;
  const turnMatch = /^turn_(?:start|end):(\d+)$/.exec(span.name);
  if (turnMatch !== null) {
    turn = Number(turnMatch[1]);
  } else {
    const tc = a.get('copilot_chat.turn_count');
    if (typeof tc === 'number') {
      turn = tc;
    }
  }

  let subagentName: string | undefined;
  const subMatch = /^runSubagent(?:-(.+))?$/.exec(span.name);
  if (subMatch !== null) {
    subagentName = subMatch[1] ?? strAttr(a, 'gen_ai.agent.name') ?? 'subagent';
  }

  return {
    candidateIds,
    operation: strAttr(a, 'gen_ai.operation.name'),
    spanName: span.name,
    model: strAttr(a, 'gen_ai.request.model') ?? strAttr(a, 'gen_ai.response.model'),
    inputTokens: numAttr(a, 'gen_ai.usage.input_tokens'),
    outputTokens: numAttr(a, 'gen_ai.usage.output_tokens'),
    cachedTokens:
      numAttr(a, 'gen_ai.usage.cached_tokens') || numAttr(a, 'gen_ai.usage.cache_read_input_tokens'),
    toolName: strAttr(a, 'gen_ai.tool.name'),
    turn,
    subagentName,
    timestampMs: nanoToMs(span.endUnixNano ?? span.startUnixNano),
  };
}
