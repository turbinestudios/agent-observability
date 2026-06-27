/**
 * Typed shapes for the JSON-lines transcripts Claude Code writes under
 * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` (and per-sub-agent under
 * `<sessionId>/subagents/agent-<id>.jsonl`).
 *
 * These mirror the on-disk format validated against real transcripts (see the
 * `claude-code-ingestion-decision` memory): every line is one JSON record with a
 * `type`. The records we care about for telemetry are `user` and `assistant`
 * (which carry tokens, models, tool calls and results); the rest (`mode`,
 * `permission-mode`, `ai-title`, `agent-name`, `system`, `attachment`,
 * `file-history-snapshot`, `last-prompt`, `summary`) are metadata.
 *
 * The parser is DEFENSIVE: a transcript is third-party data that can change shape
 * between Claude Code versions, so every field here is optional and the mapper
 * treats anything it does not recognize as absent rather than throwing. Nothing
 * in this module imports `vscode` — it is pure data, fully headless-testable.
 *
 * Privacy: raw transcript content (prompts, completions, tool I/O) is read ONLY
 * for the local detail view; like the Copilot path it is HTML-escaped before
 * display and never logged or placed on the cloud-aggregate path (which carries
 * the separate, content-free {@link ../aggregate/aggregator.AggregationRow}).
 */

/** Discriminator on a transcript line's `type`. */
export type RecordType =
  | 'user'
  | 'assistant'
  | 'system'
  | 'mode'
  | 'permission-mode'
  | 'ai-title'
  | 'agent-name'
  | 'attachment'
  | 'file-history-snapshot'
  | 'last-prompt'
  | 'summary'
  | string;

/**
 * Per-message token usage, as recorded on `assistant.message.usage`. All counts
 * are optional because older/edge records may omit them; the mapper coerces a
 * missing or non-finite value to 0.
 */
export interface TranscriptUsage {
  input_tokens?: number;
  output_tokens?: number;
  /** Tokens written to the prompt cache this turn (billed ~1.25× input). */
  cache_creation_input_tokens?: number;
  /** Tokens served from the prompt cache this turn (billed ~0.1× input). */
  cache_read_input_tokens?: number;
  /** Optional split of {@link cache_creation_input_tokens} by TTL bucket. */
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  /** Reasoning/thinking tokens, when the provider reports them. */
  reasoning_tokens?: number;
}

/** One block of a message's `content` array. */
export interface ContentBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | string;
  /** `text` blocks. */
  text?: string;
  /** `thinking` blocks. */
  thinking?: string;
  /** `tool_use` blocks: the tool name (e.g. `Read`, `Edit`, `Bash`, `Task`). */
  name?: string;
  /** `tool_use` blocks: the tool's input object (arguments). */
  input?: unknown;
  /** `tool_use` / `tool_result` blocks: correlation id. */
  id?: string;
  tool_use_id?: string;
  /** `tool_result` blocks: result payload (string or content-block array). */
  content?: unknown;
  /** `tool_result` blocks: whether the tool call errored. */
  is_error?: boolean;
}

/** The `message` object on `user` / `assistant` records. */
export interface TranscriptMessage {
  role?: 'user' | 'assistant' | string;
  /** Resolved model id for `assistant` messages (e.g. `claude-opus-4-7`). */
  model?: string;
  usage?: TranscriptUsage;
  /** Either an array of {@link ContentBlock} or a plain string (user turns). */
  content?: ContentBlock[] | string;
  stop_reason?: string | null;
}

/**
 * One parsed transcript line. Only the fields the mapper consumes are typed; the
 * raw record is preserved so future fields are reachable without a schema bump.
 */
export interface TranscriptRecord {
  type: RecordType;
  /** Stable per-event id. */
  uuid?: string;
  /** Parent event id (threads the conversation DAG). */
  parentUuid?: string | null;
  /** The session id this line belongs to (UUID; the main transcript's basename). */
  sessionId?: string;
  /** Absolute working directory of the agent when the line was written. */
  cwd?: string;
  /** Git branch checked out at the time (OMITTED from any upload, like Copilot). */
  gitBranch?: string;
  /** Claude Code version string. */
  version?: string;
  /** ISO-8601 timestamp. */
  timestamp?: string;
  /** Anthropic API request id (assistant turns). */
  requestId?: string;
  /** `true` for sub-agent side-chain transcripts. */
  isSidechain?: boolean;
  /** Whether this is an injected/meta user turn (excluded from "user request" turns). */
  isMeta?: boolean;
  /** The message payload for `user` / `assistant` records. */
  message?: TranscriptMessage;
  /**
   * Structured tool-result metadata attached to the `user` record that carries a
   * tool's result. For a `Task`/`Agent` (sub-agent) call this includes
   * `agentId`, `agentType`, `totalTokens`, `totalDurationMs`, `usage`.
   */
  toolUseResult?: ToolUseResult;
  /** `ai-title` records: the auto-generated session title. */
  aiTitle?: string;
  /** `summary` records (older format): a session summary/title. */
  summary?: string;
  /** `agent-name` records: friendly (sub-)agent name. */
  agentName?: string;
  /** `mode` records. */
  mode?: string;
  /** `permission-mode` records / per-turn permission mode (plan/auto/default/acceptEdits). */
  permissionMode?: string;
  /** `system` records: optional subtype (e.g. `turn_duration`, `compact_boundary`). */
  subtype?: string;
  /** `system` records: optional duration in ms. */
  durationMs?: number;
  /** Sub-agent linkage: the spawned agent's id (on sub-agent records + Task results). */
  agentId?: string;
  /** Sub-agent linkage: the parent tool_use id that spawned this side-chain. */
  sourceToolUseID?: string;
  /** Catch-all for fields not modelled above. */
  [key: string]: unknown;
}

/** The richer structured payload on a tool result's `toolUseResult`. */
export interface ToolUseResult {
  /** Present for `Task`/`Agent` sub-agent invocations. */
  isAgent?: boolean;
  agentId?: string;
  /** Sub-agent type, e.g. `Explore`, `Plan`, `general-purpose`. */
  agentType?: string;
  /** Sub-agent rollups (authoritative totals the parent recorded for the spawn). */
  totalTokens?: number;
  totalDurationMs?: number;
  totalToolUseCount?: number;
  usage?: TranscriptUsage;
  /** File-editing tools echo the written content / patch for LoC analysis. */
  filePath?: string;
  oldString?: string;
  newString?: string;
  /** Structured patch (apply_patch-style) when present. */
  structuredPatch?: unknown;
  [key: string]: unknown;
}

/** Type guards (defensive — never assume a shape the parser didn't verify). */

export function isAssistant(r: TranscriptRecord): boolean {
  return r.type === 'assistant' && r.message !== undefined;
}

export function isUser(r: TranscriptRecord): boolean {
  return r.type === 'user' && r.message !== undefined;
}

/** The content blocks of a message, or `[]` when content is a bare string/absent. */
export function contentBlocks(message: TranscriptMessage | undefined): ContentBlock[] {
  if (message === undefined || !Array.isArray(message.content)) {
    return [];
  }
  return message.content.filter((b): b is ContentBlock => b !== null && typeof b === 'object');
}

/** The plain text of a message: the bare string form, or joined `text` blocks. */
export function messageText(message: TranscriptMessage | undefined): string {
  if (message === undefined) {
    return '';
  }
  if (typeof message.content === 'string') {
    return message.content;
  }
  return contentBlocks(message)
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
}
