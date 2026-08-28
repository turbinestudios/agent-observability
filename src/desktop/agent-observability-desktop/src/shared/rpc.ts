/**
 * The renderer ↔ data-host contract.
 *
 * Both sides import these types, so a method rename breaks the build rather
 * than failing silently at runtime. Messages travel over a MessagePort that the
 * main process hands to the renderer, so requests never round-trip through the
 * main thread.
 *
 * The core session API is synchronous; this is the single boundary where it is
 * wrapped into promises. Everything behind `RpcMethods` runs off the UI thread.
 */

/** A session row as stored in the index — a `SessionSummary` with display extras. */
export interface SessionRow {
  source: string;
  sessionId: string;
  repository: string;
  title?: string;
  titleDerived?: boolean;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  interactionCount: number;
  llmCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  model: string;
  agentModes: string[];
  stateLabel?: string;
  externalUrl?: string;
  /** Precomputed so list rows never recompute pricing. */
  costMicros?: number;
  /**
   * The source's own name for the session, present only when the user has
   * renamed it — so the UI can offer "reset to original" and say what that is.
   */
  originalTitle?: string;
  /**
   * How many workflow deviations the background analysis found in this session.
   * Absent while the session has not been analyzed yet — which is not the same
   * as zero, so the list shows a badge only for a number greater than zero.
   */
  deviationCount?: number;
  /** Epoch ms this row was last written by the indexer. */
  indexedAtMs: number;
  /**
   * True while the row came from directory discovery alone and its counts have
   * not been parsed yet. Lets the list paint immediately on a cold start.
   */
  pending?: boolean;
}

/** One source → repository grouping with its session count, for list headers. */
export interface SessionGroup {
  source: string;
  repository: string;
  count: number;
  /** Newest `endedAtMs` in the group, so groups sort by recency. */
  newestMs: number;
}

export interface ListSessionsParams {
  source?: string;
  repository?: string;
  /** Free-text match over title and repository. */
  query?: string;
  offset?: number;
  limit?: number;
  /** Show the hidden sessions instead of the visible ones, so they can be restored. */
  hidden?: boolean;
  /** Only sessions the analysis flagged, for the Deviations chip. */
  deviations?: boolean;
}

/** What deleting a session would actually remove, for the confirmation dialog. */
export interface DeletionPlan {
  supported: boolean;
  target: string;
  consequence: string;
  caveat?: string;
}

export interface IndexStatus {
  /** Sessions with parsed counts. */
  indexed: number;
  /** Sessions known to exist, including not-yet-parsed ones. */
  total: number;
  phase: 'idle' | 'discovering' | 'hydrating' | 'error';
  /** Present when `phase` is `error`. */
  message?: string;
}

/** Which palette the detail document should render with. */
export type DetailTheme = 'light' | 'dark';

/** One session to combine, as the index identifies it. */
export interface SessionRef {
  source: string;
  sessionId: string;
}

/**
 * Most sessions one combined view will render.
 *
 * Not a UI nicety: the data host is single-threaded and its session API is
 * synchronous, so every session in a comparison is parsed one after another
 * with nothing else served in between. Ten is comfortably more than a
 * comparison needs and well short of freezing the app.
 */
export const MAX_COMPARE_SESSIONS = 10;

/** The combined document, plus what the app has to say about it around the frame. */
export interface CombinedDetailResult {
  /** Full HTML document, ready to stash. */
  html: string;
  /**
   * Present only when the selection spans cost bases. A combined view can show
   * one basis at a time, so this names the one in the document and what its
   * cost figure therefore leaves out.
   */
  costNote?: string;
  /** Selected sessions that could not be read and were left out of the view. */
  skipped: number;
}

/**
 * Accepting a file or source the analysis expected but could not find. Both are
 * remembered in settings, so the same gap is not reported again.
 */
export interface ContextAction {
  kind: 'accept-file' | 'accept-source';
  value: string;
}

/** One day's activity, for the overview charts. */
export interface DayPoint {
  /** `YYYY-MM-DD`, local time. */
  day: string;
  source: string;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
}

/** Totals plus the series the overview view charts. */
export interface OverviewData {
  totals: {
    sessions: number;
    steps: number;
    llmCalls: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    repositories: number;
    models: number;
    /** Mean wall-clock length of a session, in ms. */
    avgSessionMs: number;
  };
  /** Per-source totals, ordered by session count. */
  bySource: { source: string; sessions: number; steps: number; inputTokens: number; outputTokens: number }[];
  /** Daily activity for the window below, oldest first, sparse (no empty days). */
  daily: DayPoint[];
  /** How many days `daily` covers. */
  windowDays: number;
  /** Busiest repositories by session count. */
  topRepositories: { repository: string; sessions: number }[];
}

/**
 * Progress of the background pass that reads sessions for deviations and
 * context files. Surfaced so a view can say it is still filling in rather than
 * showing a half-built ranking as if it were the answer.
 */
export interface AnalysisStatus {
  /** Sessions in the window whose analysis is current. */
  analyzed: number;
  /** Sessions in the window, analyzed or not. */
  total: number;
  /** True while a pass is working through the backlog. */
  running: boolean;
}

/** One customization file in the Context Hotspots ranking. */
export interface HotspotRow {
  /** Absolute path when known, else the file's short name — the row's identity. */
  file: string;
  /** Short display name. */
  name: string;
  /** `instruction` | `skill` | `agent` | `hook` | `prompt` | `unknown`. */
  category: string;
  /** Sessions that had this file in their context, applied or not. */
  sessionCount: number;
  appliedCount: number;
  skippedCount: number;
  /** Sessions where the agent read the file with a tool call rather than loading it. */
  readCount: number;
  /** Largest per-session estimated token weight — what the oversized flag reads. */
  estTokensMax: number;
  /** Contributing sessions containing at least one failed interaction. */
  errorSessions: number;
  /** Contributing sessions the deviation detector flagged. */
  deviationSessions: number;
  /** Newest contributing session's end time. */
  lastSeenMs: number;
}

/** One session behind a hotspot row, for the expanded list. */
export interface HotspotSessionRow {
  source: string;
  sessionId: string;
  repository: string;
  title?: string;
  endedAtMs: number;
  /** How the file reached this session's context. */
  status: string;
  estTokens: number;
  hadError: boolean;
  hadDeviation: boolean;
}

/** The hotspots ranking plus how complete it currently is. */
export interface HotspotsResult {
  rows: HotspotRow[];
  /**
   * Repositories the ranking can be narrowed to. Returned with the rows rather
   * than fetched separately: they come from the same scan, so a second call
   * could disagree with what is on screen.
   */
  repositories: string[];
  status: AnalysisStatus;
}

/**
 * The desktop's editable settings plus what auto-detection currently resolves
 * to, so the settings page can show the effective state, not just raw values.
 */
export interface SettingsSnapshot {
  /** `claudeCode.enabled` */
  claudeEnabled: boolean;
  /** `claudeCode.projectsPath`; empty string means auto-detect. */
  claudeProjectsPath: string;
  /** `localTelemetry.enabled` */
  copilotEnabled: boolean;
  /** `sqlitePath`; empty string means auto-detect. */
  sqlitePath: string;
  /** Directories the Claude scan will actually read (override first; only existing dirs). */
  resolvedClaudeDirs: string[];
  /** True when a non-empty projects-path override does not exist on disk. */
  claudeOverrideMissing: boolean;
  /** The Copilot database the next index pass would open, if any. */
  resolvedCopilotDb?: { path: string; kind: 'archive' | 'native' | 'override' };
  /** True when a non-empty sqlitePath override does not exist on disk. */
  sqliteOverrideMissing: boolean;
  /**
   * `deviation.maxSessionMinutes` — how long a single turn may run before the
   * analysis calls it overlong.
   */
  maxSessionMinutes: number;
  /** Absolute path of the desktop config file. */
  configPath: string;
  /** Its directory, for the "open config folder" affordance. */
  configDir: string;
}

/** Partial settings update; omitted fields are untouched. `''` clears a path override. */
export interface SettingsPatch {
  claudeEnabled?: boolean;
  claudeProjectsPath?: string;
  copilotEnabled?: boolean;
  sqlitePath?: string;
  maxSessionMinutes?: number;
}

/** Request/response methods. Every one resolves off the UI thread. */
export interface RpcMethods {
  ping(payload: string): string;
  'sessions.list'(params: ListSessionsParams): SessionRow[];
  'sessions.groups'(): SessionGroup[];
  'sessions.count'(params: ListSessionsParams): number;
  /**
   * The full detail document for a session, ready to drop into an iframe.
   * Rendering happens here rather than in the renderer because it means parsing
   * a whole transcript. `force` drops the memoized parse first, so an active
   * session's document reflects the transcript as it is on disk right now.
   */
  'sessions.detail'(source: string, sessionId: string, theme: DetailTheme, force?: boolean): string;
  /**
   * Body-only markup for an already-open detail document. The document's own
   * controller swaps it in place, which preserves the active tab, open
   * sections, and scroll position — a full reload would lose all three.
   */
  'sessions.detailBody'(source: string, sessionId: string): string;
  /**
   * One document combining several sessions — merged totals, a token trend with
   * each session's span labelled, and a collapsible section per session. Two or
   * more sessions, at most {@link MAX_COMPARE_SESSIONS}; sessions that cannot be
   * read are left out and counted rather than failing the whole view.
   */
  'sessions.combinedDetail'(keys: SessionRef[], theme: DetailTheme): CombinedDetailResult;
  /**
   * Record an accepted context gap and return refreshed body markup. Combined
   * because the two always happen together: the setting only matters once the
   * view reflects it.
   */
  'sessions.contextAction'(source: string, sessionId: string, action: ContextAction): string;
  /**
   * Give a session a user-chosen name, or clear it with an empty string.
   * Returns the row as it now reads.
   */
  'sessions.rename'(source: string, sessionId: string, title: string): SessionRow | undefined;
  /**
   * Take a session out of the list, or put it back. Reversible, and touches
   * nothing on disk.
   */
  'sessions.hide'(source: string, sessionId: string, hidden: boolean): void;
  /** How many sessions are currently hidden, so the UI can offer to show them. */
  'sessions.hiddenCount'(): number;
  /** What a permanent delete would remove. Read-only — nothing is deleted. */
  'sessions.deletionPlan'(source: string, sessionId: string): DeletionPlan;
  /**
   * Permanently remove a session's underlying data. Irreversible; call only
   * after the user has confirmed against {@link RpcMethods['sessions.deletionPlan']}.
   */
  'sessions.delete'(source: string, sessionId: string): { ok: boolean; detail: string };
  /**
   * One indexed row by key, with the user's chosen name applied. Lets a view
   * outside the Sessions list open a session that is not on the current page or
   * does not match the active filter.
   */
  'sessions.row'(source: string, sessionId: string): SessionRow | undefined;
  'overview.get'(): OverviewData;
  /**
   * The Context Hotspots ranking, aggregated in SQL over what the background
   * analysis has read so far. Returns the ranking it can build right now plus
   * its progress, so the view can show partial results honestly instead of an
   * empty screen while the first pass runs.
   */
  'hotspots.get'(params?: { repository?: string }): HotspotsResult;
  /** The sessions behind one hotspot row, newest first. */
  'hotspots.sessions'(file: string, params?: { repository?: string }): HotspotSessionRow[];
  /** Progress of the background analysis pass. */
  'analysis.status'(): AnalysisStatus;
  /** The editable settings plus what auto-detection currently resolves to. */
  'settings.get'(): SettingsSnapshot;
  /**
   * Persist a partial settings update. Sources whose settings changed are
   * re-indexed automatically; the returned snapshot reflects the new state.
   */
  'settings.update'(patch: SettingsPatch): SettingsSnapshot;
  'index.status'(): IndexStatus;
  'index.refresh'(): IndexStatus;
  /** Drop and rebuild the index from scratch — the recovery path. */
  'index.rebuild'(): IndexStatus;
}

export type RpcMethodName = keyof RpcMethods;

export type RpcRequest = {
  [K in RpcMethodName]: {
    id: number;
    method: K;
    params: Parameters<RpcMethods[K]>;
  };
}[RpcMethodName];

export type RpcResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string };

/** Unsolicited pushes from the data host. */
export type RpcEvent =
  | { event: 'sessions.upserted'; rows: SessionRow[] }
  | { event: 'sessions.removed'; keys: string[] }
  | { event: 'index.progress'; status: IndexStatus }
  | { event: 'analysis.progress'; status: AnalysisStatus };

export type RpcEventName = RpcEvent['event'];

/** Stable identity for a session row across sources. */
export function sessionKey(source: string, sessionId: string): string {
  return `${source}:${sessionId}`;
}
