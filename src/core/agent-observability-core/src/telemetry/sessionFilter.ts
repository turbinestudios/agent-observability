/**
 * Which span groups in Copilot's database count as real sessions.
 *
 * The `spans` table groups by `COALESCE(conversation_id, chat_session_id)`, and
 * plenty of those groups are not sessions a person would recognize: tool-call
 * ids, and the conversation ids minted by chat helpers (next-edit suggestions,
 * commit-message and title generators, language-model wrappers). Listing them
 * buries the real work — on one machine here it is 431 pieces of noise around
 * 4 actual sessions.
 *
 * The rule lives here, rather than inside any one reader, because more than one
 * host queries this data: the extension through `TelemetryDatabase`, the desktop
 * app through its own indexer. Two copies of a filter this subtle would drift,
 * and the symptom — a list quietly full of junk — is easy to miss.
 *
 * These are fixed expressions, never user input.
 */

/** The `sessions` view's grouping key, for queries that must group identically. */
export const SESSION_KEY_EXPR = 'COALESCE(conversation_id, chat_session_id)';

/**
 * A real chat-session id, as opposed to a `call_…` sub-agent spawn id or a
 * `toolu_…` tool-call id that also lands in `chat_session_id`. Only a UUID is
 * joinable to the local title store.
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * (a) Chat-session ids carrying at least one span of any kind.
 *
 * Length is filtered in SQL and the UUID shape in code, because SQLite has no
 * regex; callers must apply {@link UUID_RE} to the result.
 */
export const CHAT_SESSION_CANDIDATES_SQL = `
  SELECT DISTINCT chat_session_id AS session_key
    FROM spans
   WHERE chat_session_id IS NOT NULL
     AND LENGTH(chat_session_id) = 36
`;

/**
 * (b) Session keys whose spans carry NO `chat_session_id` — the autonomous
 * Copilot CLI shape, where the conversation id is the session.
 *
 * Requiring an agent-run span is what keeps conversation-keyed chat-helper
 * noise out: those helpers produce `chat` spans but never invoke an agent,
 * execute a tool, or run a hook.
 */
export const CONVERSATION_ONLY_CANDIDATES_SQL = `
  SELECT ${SESSION_KEY_EXPR} AS session_key
    FROM spans
   WHERE ${SESSION_KEY_EXPR} IS NOT NULL
     AND LENGTH(${SESSION_KEY_EXPR}) = 36
   GROUP BY ${SESSION_KEY_EXPR}
  HAVING SUM(CASE WHEN chat_session_id IS NOT NULL AND chat_session_id <> '' THEN 1 ELSE 0 END) = 0
     AND SUM(CASE WHEN operation_name IN ('invoke_agent', 'execute_tool', 'execute_hook') THEN 1 ELSE 0 END) > 0
`;

/**
 * Session keys whose chat spans use ONLY inline-suggestion models — no real
 * chat model — which makes them autocomplete traffic rather than a session.
 *
 * Applied per shape with its own key: grouping the Copilot Chat case by the
 * session key instead would break it, because those rows are keyed by per-turn
 * conversation ids. `keyExpr` must be one of the fixed expressions above.
 */
export function suggestionOnlySql(keyExpr: string): string {
  return `
  SELECT ${keyExpr} AS session_key
    FROM spans
   WHERE ${keyExpr} IS NOT NULL
     AND operation_name = 'chat'
   GROUP BY ${keyExpr}
  HAVING SUM(CASE WHEN COALESCE(response_model, request_model) NOT LIKE '%suggestions%' THEN 1 ELSE 0 END) = 0
`;
}

/**
 * Build the started-session set from the candidate queries' rows, keeping only
 * UUID-shaped keys and dropping suggestion-only traffic.
 *
 * Sessions with no chat spans at all are absent from the suggestion-only sets
 * and are therefore admitted.
 */
export function startedSessionSet(
  chatSessionRows: readonly { session_key: string }[],
  conversationOnlyRows: readonly { session_key: string }[],
  suggestionOnlyByChatSession: ReadonlySet<string> = new Set(),
  suggestionOnlyByKey: ReadonlySet<string> = new Set(),
): Set<string> {
  const started = new Set<string>();
  for (const row of chatSessionRows) {
    if (UUID_RE.test(row.session_key) && !suggestionOnlyByChatSession.has(row.session_key)) {
      started.add(row.session_key);
    }
  }
  for (const row of conversationOnlyRows) {
    if (UUID_RE.test(row.session_key) && !suggestionOnlyByKey.has(row.session_key)) {
      started.add(row.session_key);
    }
  }
  return started;
}
