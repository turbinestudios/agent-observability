import { AttrValue, FlatSpan } from './otlpParse';

/**
 * Map flattened OTLP spans into rows matching Copilot's `agent-traces.db` schema,
 * so the extension can persist its OWN ingested copy and reuse the entire existing
 * read/detail/deviation/aggregation layer unchanged.
 *
 * The mapping mirrors how Copilot itself populates the DB (verified against the
 * real schema + a captured OTLP/JSON `/v1/traces` payload, 2026-06-26): the typed
 * `spans` columns come from the well-known `gen_ai.*` / `copilot_chat.*`
 * attributes, and EVERY attribute is also written verbatim to `span_attributes`
 * (span_id, key, value) — which is where content predicates, AIU
 * (`copilot_chat.copilot_usage_nano_aiu`), repo (`copilot_chat.repo.remote_url`),
 * `copilot_chat.parent_chat_session_id`, `copilot_chat.mode_name`, and
 * `copilot_chat.debug_log_label` are read from. Pure: no `vscode`, no DB, no fs.
 */

/** One row of the `spans` table (column names match the schema exactly). */
export interface SpanRow {
  span_id: string;
  trace_id: string;
  parent_span_id: string | null;
  name: string;
  start_time_ms: number;
  end_time_ms: number;
  status_code: number;
  status_message: string | null;
  operation_name: string | null;
  provider_name: string | null;
  agent_name: string | null;
  conversation_id: string | null;
  request_model: string | null;
  response_model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  reasoning_tokens: number | null;
  tool_name: string | null;
  tool_call_id: string | null;
  tool_type: string | null;
  chat_session_id: string | null;
  turn_index: number | null;
  ttft_ms: number | null;
}

/** One row of the `span_attributes` table. */
export interface AttrRow {
  span_id: string;
  key: string;
  value: string | null;
}

/** Rows to persist for a batch of spans. */
export interface SpanRows {
  spans: SpanRow[];
  attributes: AttrRow[];
}

function str(a: Map<string, AttrValue>, key: string): string | null {
  const v = a.get(key);
  return typeof v === 'string' ? v : v === undefined ? null : String(v);
}

function int(a: Map<string, AttrValue>, key: string): number | null {
  const v = a.get(key);
  if (typeof v === 'number' && Number.isFinite(v)) {
    return Math.trunc(v);
  }
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
    return Math.trunc(Number(v));
  }
  return null;
}

function real(a: Map<string, AttrValue>, key: string): number | null {
  const v = a.get(key);
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

/** Nanosecond epoch string → integer ms, or `undefined` when unparseable. */
function nanoToMs(nano?: string): number | undefined {
  if (typeof nano !== 'string' || nano.length === 0) {
    return undefined;
  }
  const n = Number(nano);
  return Number.isFinite(n) ? Math.floor(n / 1e6) : undefined;
}

/**
 * Convert flattened OTLP spans to `spans` + `span_attributes` rows. Spans without
 * a `spanId` are skipped (it is the primary key). An attribute value of any
 * non-string type is stringified, matching how Copilot stores `span_attributes`.
 */
export function otlpSpansToRows(flat: readonly FlatSpan[]): SpanRows {
  const spans: SpanRow[] = [];
  const attributes: AttrRow[] = [];

  for (const { span } of flat) {
    const spanId = span.spanId;
    if (spanId === undefined || spanId.length === 0) {
      continue;
    }
    const a = span.attributes;
    const startMs = nanoToMs(span.startUnixNano) ?? 0;

    spans.push({
      span_id: spanId,
      trace_id: span.traceId ?? '',
      parent_span_id: span.parentSpanId ?? null,
      name: span.name,
      start_time_ms: startMs,
      end_time_ms: nanoToMs(span.endUnixNano) ?? startMs,
      status_code: span.status?.code ?? 0,
      status_message: span.status?.message ?? null,
      operation_name: str(a, 'gen_ai.operation.name'),
      provider_name: str(a, 'gen_ai.provider.name'),
      agent_name: str(a, 'gen_ai.agent.name'),
      conversation_id: str(a, 'gen_ai.conversation.id'),
      request_model: str(a, 'gen_ai.request.model'),
      response_model: str(a, 'gen_ai.response.model'),
      input_tokens: int(a, 'gen_ai.usage.input_tokens'),
      output_tokens: int(a, 'gen_ai.usage.output_tokens'),
      // Copilot folds the cache-read tokens into the `cached_tokens` column.
      cached_tokens: int(a, 'gen_ai.usage.cache_read.input_tokens'),
      reasoning_tokens:
        int(a, 'gen_ai.usage.reasoning_tokens') ?? int(a, 'gen_ai.usage.reasoning.output_tokens'),
      tool_name: str(a, 'gen_ai.tool.name'),
      tool_call_id: str(a, 'gen_ai.tool.call.id'),
      tool_type: str(a, 'gen_ai.tool.type'),
      chat_session_id: str(a, 'copilot_chat.chat_session_id'),
      // Copilot leaves turn_index NULL on trace spans that carry copilot_chat.turn_count
      // (verified against its agent-traces.db), so mirror that — only the rare bare
      // `turn.index` populates it. `copilot_chat.turn_count` is still kept in span_attributes.
      turn_index: int(a, 'turn.index'),
      ttft_ms: real(a, 'copilot_chat.time_to_first_token'),
    });

    for (const [key, value] of a) {
      attributes.push({ span_id: spanId, key, value: value === undefined ? null : String(value) });
    }
  }

  return { spans, attributes };
}
