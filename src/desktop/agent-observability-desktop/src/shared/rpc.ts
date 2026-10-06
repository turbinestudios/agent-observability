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
  /**
   * Precomputed so list rows never recompute pricing. Integer micro-USD:
   * estimated token×rate for `claude`, derived from billed AIU for `copilot`.
   * ABSENT means unpriced (unknown model / AIU untracked), which is not the
   * same statement as a genuine 0.
   */
  costMicros?: number;
  /**
   * The source's own name for the session, present only when the user has
   * renamed it — so the UI can offer "reset to original" and say what that is.
   */
  originalTitle?: string;
  /**
   * The user's labels for this session, in the case they typed. Absent means
   * none — the field is optional so every indexer and fixture that builds a row
   * stays untouched. LOCAL-ONLY: these live in a JSON store beside the renames,
   * never in `index.db` (a rebuild must not lose them) and never on any
   * aggregate, sync, or AI path.
   */
  tags?: string[];
  /** A free-text note is attached. The note itself is fetched per session. */
  hasNote?: boolean;
  /**
   * How many workflow deviations the background analysis found in this session.
   * Absent while the session has not been analyzed yet — which is not the same
   * as zero, so the list shows a badge only for a number greater than zero.
   */
  deviationCount?: number;
  /**
   * The retrospective's one-word judgement of how the session went. Absent
   * while unanalyzed or when the retrospective could not be built — which is
   * not the same as smooth, so the list marks only rows that carry a verdict.
   */
  verdict?: RetroVerdict;
  /**
   * What the completion check observed for a session that changed code:
   * whether a test, build, lint or type-check was seen after the last edit and
   * how it ended. Absent while unanalyzed, when the session changed no code,
   * or when the source records no commands. LOCAL-ONLY.
   */
  completion?: CompletionStatus;
  /** The session's last reply reported the work as done. Only set with `completion`. */
  claimedDone?: boolean;
  /** Files this session edited in several separate turns. Absent when none. A proxy, not a score. */
  filesReedited?: number;
  /** Lines the session added and removed again in a later turn. Absent when none. */
  reworkedLines?: number;
  /**
   * Index revision, based on epoch ms. Unchanged Copilot refreshes preserve it;
   * changed rows advance it even when the clock has not. Keys analysis/detail
   * caches, not a user-facing "last checked" timestamp.
   */
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
  /** Only sessions the retrospective judged struggled or abandoned. */
  friction?: boolean;
  /** Only sessions the retrospective judged exactly this — the Dashboard's slice drill-down. */
  verdict?: RetroVerdict;
  /**
   * Only sessions whose retrospective raised this finding signal (beyond
   * info severity) — the Dashboard's friction-theme drill-down.
   */
  signal?: string;
  /**
   * Date range, inclusive, over the session's END time — the same instant the
   * list sorts by and the overview buckets its day columns by. Filtering on the
   * start time instead would make a day column open a different set of sessions
   * than the column counted.
   */
  endedAfterMs?: number;
  endedBeforeMs?: number;
  /** Only sessions carrying this user tag. Matched case-insensitively. */
  tag?: string;
  /** Only sessions that called this tool — the Tools ranking's drill-down. */
  tool?: string;
  /** With `tool`: only sessions where that tool failed at least once. */
  toolFailed?: boolean;
  /** Only sessions whose completion check ended in this status. */
  completion?: CompletionStatus;
  /** Only sessions whose completion check ended in one of these statuses. */
  completionIn?: CompletionStatus[];
  /** Only sessions whose last reply reported the work as done. */
  claimedDone?: boolean;
  /** Only sessions the rework signal fired for. */
  reworked?: boolean;
}

/** One user tag and how many sessions carry it, for the filter and the picker. */
export interface TagCount {
  /** Display case — whichever spelling the tag is most often written in. */
  tag: string;
  count: number;
}

/**
 * How the retrospective judged a session. Mirrors core's `SessionVerdict`
 * (kept as a local union so this contract file stays import-free; the datahost
 * assignment from core's type makes drift a compile error).
 */
export type RetroVerdict = 'smooth' | 'bumpy' | 'struggled' | 'abandoned';

/**
 * One loaded context file as the "Improve context files" prompt describes it.
 * Mirrors core's `ContextPromptFile`, kept local so this contract file stays
 * import-free (the datahost's assignment from core's type makes drift a
 * compile error). `category` is core's `ContextFileCategory`.
 */
export interface ContextPromptFile {
  name: string;
  path?: string;
  category: 'instruction' | 'skill' | 'agent' | 'hook' | 'prompt' | 'unknown';
  estimatedTokens?: number;
  oversized: boolean;
  missingRefs: string[];
}

/** One Context Analysis section's facts for the prompt. Mirrors core's `ContextPromptFacts`. */
export interface ContextPromptFacts {
  agentName: string;
  files: ContextPromptFile[];
  contextFileTokens: number;
  totalContextTokens: number;
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

/**
 * How far back the Dashboard looks. `'all'` means no cutoff at all, which is
 * what the whole view used to be before the window applied to more than the
 * per-day charts — so nobody loses the totals they were reading.
 */
export type OverviewWindow = 7 | 30 | 90 | 'all';

/** Every selectable window, in the order the segmented control shows them. */
export const OVERVIEW_WINDOWS: readonly OverviewWindow[] = [7, 30, 90, 'all'];

export const DEFAULT_OVERVIEW_WINDOW: OverviewWindow = 30;

/**
 * Widest daily series the charts will draw. `'all'` leaves the tiles uncapped
 * but has to stop somewhere for the columns, or years of history would be drawn
 * as a thousand slivers.
 */
export const MAX_DAILY_COLUMNS = 366;

/** Narrow an untrusted value to a window, falling back to the default. */
export function toOverviewWindow(value: unknown): OverviewWindow {
  return OVERVIEW_WINDOWS.includes(value as OverviewWindow)
    ? (value as OverviewWindow)
    : DEFAULT_OVERVIEW_WINDOW;
}

/**
 * The first instant of a `days`-long window that ends today — local midnight,
 * `days - 1` days ago.
 *
 * Local rather than a rolling `now - days * 24h` because the overview groups by
 * local day: a rolling cutoff lands mid-morning on the oldest day, so that
 * column would show a fraction of its real total with nothing saying why.
 *
 * Shared rather than defined on each side, because the data host aggregates the
 * window and the renderer hands the same range to a drill-down. Two definitions
 * would eventually differ by a few hours, and the list would quietly disagree
 * with the tile that was clicked.
 */
export function windowStartMs(days: number, now: number = Date.now()): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return start.getTime();
}

/** One day's activity, for the overview charts. */
export interface DayPoint {
  /** `YYYY-MM-DD`, local time. */
  day: string;
  source: string;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  /** Estimated micro-USD that day; unpriced sessions contribute nothing. */
  costMicros: number;
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
    /** Estimated micro-USD over the PRICED sessions only. */
    costMicros: number;
    /**
     * Sessions with a known cost — the honesty denominator for the cost tile
     * ("covers N of M sessions"); the rest could not be priced.
     */
    costSessions: number;
    repositories: number;
    models: number;
    /** Mean wall-clock length of a session, in ms. */
    avgSessionMs: number;
  };
  /** Per-source totals, ordered by session count. */
  bySource: {
    source: string;
    sessions: number;
    steps: number;
    inputTokens: number;
    outputTokens: number;
    /** Estimated micro-USD for the source's priced sessions. */
    costMicros: number;
  }[];
  /** Daily activity for the window below, oldest first, sparse (no empty days). */
  daily: DayPoint[];
  /** How many days `daily` covers. */
  windowDays: number;
  /** The window every figure above was computed over. */
  window: OverviewWindow;
  /**
   * Set only when `window` is `'all'` and the history is longer than
   * {@link MAX_DAILY_COLUMNS}: the tiles cover everything but the day charts
   * stop at `windowDays`, and the cards have to say so rather than letting two
   * time scales sit on one page unannounced.
   */
  dailyCapped?: true;
  /** Busiest repositories by session count. */
  topRepositories: { repository: string; sessions: number }[];
  /**
   * Cost/usage by dominant session model, priciest first. A NULL cost means no
   * session of that model could be priced — "n/a", never rendered as free.
   */
  byModel: {
    model: string;
    sessions: number;
    llmCalls: number;
    inputTokens: number;
    outputTokens: number;
    costMicros: number | null;
  }[];
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

/** One judged session in the Retro view's ranking. */
export interface RetroListRow {
  source: string;
  sessionId: string;
  repository: string;
  title?: string;
  endedAtMs: number;
  verdict: RetroVerdict;
  /** Core's `SessionOutcome` label (`likely-fulfilled`, `unclear`, …). */
  outcome: string;
  correctionTurns: number;
  repeatedPromptTurns: number;
  interruptions: number;
  maxErrorStreak: number;
  churnRatioPct: number;
  compactions: number;
  tipCount: number;
}

/** The Retro ranking plus how complete it currently is. */
export interface RetroResult {
  /** Worst verdict tier first, most recent first within a tier. */
  rows: RetroListRow[];
  /** Same-scan repository list, for the same reason as {@link HotspotsResult}. */
  repositories: string[];
  status: AnalysisStatus;
}

// ── Workspace: live board + repository hubs ─────────────────────────────────

/**
 * What a session is doing right now, derived from the tail of its own log on
 * this machine (no hooks installed into the agent). Mirrors core's
 * `live/liveStatus.ts`; kept as a local union so this file stays import-free.
 */
export type LiveStatus = 'working' | 'waiting' | 'idle' | 'finished';

/** The last substantive record in the transcript, for the status hint. */
export type LiveLastEvent =
  | 'tool-pending'
  | 'assistant-text'
  | 'turn-ended'
  | 'user-prompt'
  | 'tool-result'
  | 'interruption'
  | 'unknown';

/** One card on the live board. */
export interface LiveSessionRow {
  source: string;
  sessionId: string;
  repository: string;
  title?: string;
  status: LiveStatus;
  lastEvent: LiveLastEvent;
  startedAtMs: number;
  lastActivityMs: number;
  /** Git branch from the transcript. LOCAL-ONLY display; never leaves the machine. */
  branch?: string;
  /** Tool calls issued without a result yet (names only). */
  pendingTools: string[];
  model?: string;
  inputTokens: number;
  outputTokens: number;
  costMicros?: number;
  /** When the token/cost figures were indexed; they can lag the transcript. */
  countsIndexedAtMs: number;
  /** The app itself is hosting this session (Run), so its status is exact. */
  hosted?: boolean;
  /** The newest tool result failed and nothing followed it. Not part of the board's change fingerprint. */
  lastToolFailed?: boolean;
  /** The session is known (not guessed) to be waiting on a permission request. */
  exactPermission?: boolean;
}

export interface LiveBoardSnapshot {
  rows: LiveSessionRow[];
  generatedAtMs: number;
  /** False when no transcript directory could be watched (source off, or none found). */
  watching: boolean;
  watchedDirs: number;
  idleMs: number;
  finishedMs: number;
  /** A human-readable reason the board is degraded, when it is. */
  note?: string;
}

// ── Attention inbox ─────────────────────────────────────────────────────────

/** Why a session is in the inbox. Mirrors core's `inbox/attention.ts`. */
export type InboxReason = 'permission' | 'permission-likely' | 'waiting' | 'finished' | 'ended-error' | 'ended-interrupted';
export type InboxState = 'new' | 'seen' | 'dismissed' | 'snoozed';
export type InboxFlag = 'contradicted' | 'unverified' | 'incomplete' | 'struggled' | 'abandoned' | 'cost-outlier';

/** One thing that needs the developer, or finished since they last looked. */
export interface InboxItem {
  /** `source:sessionId|reason` — the identity `inbox.mark` takes. */
  key: string;
  source: string;
  sessionId: string;
  reason: InboxReason;
  state: InboxState;
  /** Lower sorts first. */
  tier: number;
  flags: InboxFlag[];
  /** True when the reason is known rather than inferred from a quiet transcript. */
  exact: boolean;
  repository: string;
  title?: string;
  /** When this episode began: the wait started, or the session ended. */
  sinceMs: number;
  pendingTools: string[];
  verdict?: RetroVerdict;
  costMicros?: number;
  snoozedUntilMs?: number;
}

export interface InboxSnapshot {
  items: InboxItem[];
  /** Items in state `new`. */
  unread: number;
  generatedAtMs: number;
  lastVisitMs: number;
}

/** One repository card below the live board. */
export interface RepositoryCard {
  repository: string;
  sessions: number;
  lastActivityMs: number;
  /** Live sessions on the board right now (any status but finished). */
  live: number;
  waiting: number;
  bySource: { source: string; sessions: number }[];
  verdicts: Record<RetroVerdict | 'unjudged', number>;
  costMicros: number;
  costSessions: number;
}

export interface RepositoryCards {
  cards: RepositoryCard[];
  /** Sessions in the window whose repository could not be resolved. */
  unknownSessions: number;
  window: OverviewWindow;
}

/** One rule / skill / instruction file found on disk in a repository checkout. */
export interface ContextInventoryFile {
  /** Repo-relative POSIX path. */
  relPath: string;
  kind: 'memory' | 'rule' | 'instruction' | 'skill' | 'agent' | 'prompt';
  agent: 'claude' | 'copilot' | 'shared';
  bytes: number;
  estTokens: number;
  /** How agents used this file across indexed sessions; absent when never seen. */
  usage?: {
    /** Absolute path as the index knows it — the Hotspots view's row identity. */
    file: string;
    sessionCount: number;
    appliedCount: number;
    skippedCount: number;
    readCount: number;
    estTokensMax: number;
    lastSeenMs: number;
  };
}

export interface ContextInventory {
  /** The resolved checkout. LOCAL-ONLY — never leaves this machine. */
  root: string;
  files: ContextInventoryFile[];
  /** Context files agents loaded that live OUTSIDE the checkout (user-level memory). */
  outsideRepo: HotspotRow[];
  truncated: boolean;
}

/** Everything the repository hub shows. */
export interface RepoHubData {
  repository: string;
  window: OverviewWindow;
  windowDays: number;
  totals: OverviewData['totals'];
  /** The equal-length window before this one, for the trend figures. */
  previousTotals: { sessions: number; costMicros: number };
  verdicts: Record<RetroVerdict | 'unjudged', number>;
  previousVerdicts: Record<RetroVerdict | 'unjudged', number>;
  themes: (ThemeRow & { previousSessions: number })[];
  models: OverviewData['byModel'];
  recent: SessionRow[];
  live: LiveSessionRow[];
  contextUsage: HotspotRow[];
  inventory: ContextInventory | { error: string };
  plans: ContextPlanSummary[];
  status: AnalysisStatus;
}

/**
 * The input to the locally built "what the agents learned here" digest.
 * Field-for-field mirror of core's `analysis/repositoryDigest.ts`
 * `RepositoryDigestInput`; the datahost assigns core's value to this type, so
 * drift is a compile error. Carries NO absolute paths and NO branch names.
 */
export interface RepositoryDigestInput {
  repository: string;
  windowDays: number;
  generatedAtMs: number;
  sessions: {
    total: number;
    previousTotal: number;
    bySource: { source: string; sessions: number }[];
    verdicts: Record<RetroVerdict | 'unjudged', number>;
    previousVerdicts: Record<RetroVerdict | 'unjudged', number>;
  };
  themes: { signalId: string; label: string; sessions: number; previousSessions: number; occurrences: number }[];
  tips: { id: string; text: string; sessions: number }[];
  hotspots: {
    path: string;
    category: string;
    sessionCount: number;
    appliedCount: number;
    skippedCount: number;
    estTokensMax: number;
  }[];
  models: { model: string; sessions: number; costMicros: number | null }[];
  tools?: { name: string; calls: number; failures: number; sampledSessions?: number }[];
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    costMicros: number;
    costSessions: number;
  };
  contextFiles: {
    relPath: string;
    kind: string;
    agent: string;
    estTokens: number;
    seenInSessions: number;
    skippedCount: number;
  }[];
}

// ── Review packet and hand-off brief ────────────────────────────────────────
//
// Field-for-field mirrors of core's `analysis/reviewPacket.ts` and
// `analysis/handoffBrief.ts` (this file stays import-free; the datahost's
// assignment and the renderer's call into core's pure renderers make drift a
// compile error). Both are LOCAL, built on the user's request and shown in a
// dialog; they leave the app only through the clipboard. Paths are
// repo-relative or bare names, quoted text is redacted in core, and neither
// carries a branch name, an absolute path or any tool output.

export type PacketCommandClass =
  | 'test' | 'build' | 'lint' | 'typecheck' | 'install' | 'git' | 'run' | 'network' | 'filesystem' | 'other';
export type PacketRiskId =
  | 'rm-rf' | 'force-push' | 'no-verify' | 'hard-reset' | 'credential-in-command' | 'write-outside-repo'
  | 'package-install' | 'network-call' | 'ci-change' | 'env-file-write' | 'permission-bypass' | 'sudo' | 'pipe-to-shell';
export type PacketCompletionStatus = 'verified' | 'unverified' | 'contradicted' | 'incomplete' | 'not-applicable';

export interface PacketFileRollup {
  path: string;
  insideRepo: boolean;
  linesAdded: number;
  linesRemoved: number;
  edits: number;
  reEdits: number;
  turns: number;
  firstTurn: number;
  lastTurn: number;
}

export interface ReviewPacket {
  source: string;
  sessionId: string;
  repository: string;
  title?: string;
  goal?: { text: string; fromPrompt: boolean };
  turns: { index: number; line?: string; outcome: 'ok' | 'failed' | 'corrected' | 'interrupted' }[];
  turnsOmitted: number;
  files: PacketFileRollup[];
  filesOmitted: number;
  filesAvailable: boolean;
  commands: { class: PacketCommandClass; runs: number; failures: number }[];
  verification: {
    status: PacketCompletionStatus | 'not-checked';
    testRuns: number;
    testFailures: number;
    lastTestFailed?: boolean;
    checks: { label: string; passed: boolean }[];
  };
  deadEnds: { turnIndex: number; kind: 'correction' | 'interruption' | 'error-streak' | 'repeated-prompt'; note: string }[];
  risks: { id: PacketRiskId; label: string; turnIndex?: number; count: number; quote?: string }[];
  risksOmitted: number;
  subAgents: { name: string; calls: number; tokenSharePct?: number }[];
  models: { model: string; inputTokens: number; outputTokens: number }[];
  totals: { inputTokens: number; outputTokens: number; cachedTokens: number; costMicros?: number; durationMs: number; turns: number };
  costMode: 'aiu' | 'usd' | 'credits';
  verdict: RetroVerdict;
  outcome: 'likely-fulfilled' | 'partially' | 'unclear' | 'likely-unfulfilled';
  findings: { severity: string; text: string }[];
  tips: string[];
  redactions: number;
}

export interface ReviewPacketResult {
  packets: ReviewPacket[];
  /** Sessions that could not be read; listed in the dialog, never silently dropped. */
  skipped: { source: string; sessionId: string; message: string }[];
  note?: string;
}

export interface HandoffBrief {
  source: string;
  sessionId: string;
  repository: string;
  goal?: string;
  state: {
    turns: number;
    ending: 'turn-complete' | 'waiting' | 'interrupted' | 'error' | 'tool-pending' | 'unknown';
    lastRequest?: string;
    lastTurnFailed: boolean;
    filesChanged: number;
  };
  constraints: { turnIndex: number; text: string; kind: 'constraint' | 'correction' }[];
  files: { path: string; insideRepo: boolean; edits: number; lastTurn: number }[];
  verified: string[];
  notVerified: string[];
  openItems: { text: string; origin: 'last-reply' | 'failed-command' | 'interrupted' }[];
  contextFiles: string[];
  suggestedPrompt: string;
  redactions: number;
}

/**
 * What "Resume in terminal" needs. Three plain values; the main process
 * builds and validates the command itself and never takes one from here.
 */
export interface ResumeTarget {
  /** LOCAL-ONLY working directory, re-read from the session's own files. */
  cwd?: string;
  sessionId: string;
  cli: 'claude' | 'copilot';
  /** Why the session cannot be resumed in a terminal, when it cannot. */
  problem?: string;
}

// ── Team: anonymous aggregates through a shared folder ──────────────────────

/** How far back the Team view looks. Mirrors core's `team/teamViewModels.ts`. */
export type TeamWindow = 7 | 30 | 90;
export const TEAM_WINDOWS: readonly TeamWindow[] = [7, 30, 90];
export const DEFAULT_TEAM_WINDOW: TeamWindow = 30;

export function toTeamWindow(value: unknown): TeamWindow {
  return TEAM_WINDOWS.includes(value as TeamWindow) ? (value as TeamWindow) : DEFAULT_TEAM_WINDOW;
}

export type TeamVerdict = RetroVerdict | 'unjudged';
export type TeamCostMode = 'usd' | 'aiu' | 'credits';
export type ShardProblemReason = 'unknown-schema-version' | 'invalid' | 'id-mismatch' | 'too-large' | 'unreadable';

export interface TeamStatus {
  /** The chosen folder, or '' when unset. */
  folder: string;
  folderState: 'unset' | 'ok' | 'missing' | 'unreadable';
  watchMode: 'events+poll' | 'poll' | 'off';
  shareEnabled: boolean;
  autoExport: boolean;
  /** The viewer's own anonymous id, so the view can mark "you". */
  developerId: string;
  lastExportAtMs?: number;
  lastExportBytes?: number;
  lastExportError?: string;
  exporting: boolean;
  /** Shards merged from the folder, the viewer's own included. */
  memberCount: number;
  problems: { fileName: string; reason: ShardProblemReason; detail?: string }[];
  lastReadAtMs?: number;
}

export interface TeamMemberInfo {
  developerId: string;
  isMe: boolean;
  generatedAtMs: number;
  toolVersion: string;
  windowStartMs: number;
  windowEndMs: number;
  bucketCount: number;
  contextRowCount: number;
  outcomeRowCount: number;
  stale: boolean;
}

/** The exact file that sharing would write, for the preview dialog. */
export interface TeamPreview {
  json: string;
  bytes: number;
  developerId: string;
  windowStartMs: number;
  windowEndMs: number;
  /** Repositories that would appear in the file, sanitized form. */
  repositories: string[];
  bucketCount: number;
  contextRowCount: number;
  outcomeRowCount: number;
  shareEnabled: boolean;
}

/** Error-as-value, like {@link DeepRetroResult}. */
export interface TeamExportResult {
  ok: boolean;
  path?: string;
  bytes?: number;
  bucketCount?: number;
  contextRowCount?: number;
  outcomeRowCount?: number;
  error?: string;
}

export interface TeamDayPoint {
  day: string;
  members: number;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}

export interface TeamVerdictDayPoint {
  day: string;
  verdict: TeamVerdict;
  sessions: number;
}

export interface TeamRepositoryRow {
  repository: string;
  sessions: number;
  members: number;
  mine: number;
}

export interface TeamHotspotRow {
  repository: string;
  contextFile: string;
  category: string;
  appliedCount: number;
  skippedCount: number;
  estTokensMax: number;
  errorSessions: number;
  deviationSessions: number;
  members: number;
  score: number;
}

export interface TeamFigures {
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  verdictMix: Record<TeamVerdict, number>;
}

export interface TeamMeVsTeam {
  mine: TeamFigures;
  teamMedian: TeamFigures;
  teamMean: TeamFigures;
  rankBySessions?: number;
  comparedMembers: number;
}

/** Everything the Team view draws. Mirrors core's `TeamMetrics` plus the status. */
export interface TeamViewData {
  window: TeamWindow;
  days: string[];
  totals: {
    members: number;
    activeMembers: number;
    sessions: number;
    inputTokens: number;
    outputTokens: number;
    costMicros: number;
    pricedSessions: number;
    repositories: number;
  };
  daily: TeamDayPoint[];
  verdictDaily: TeamVerdictDayPoint[];
  verdictMix: Record<TeamVerdict, number>;
  topRepositories: TeamRepositoryRow[];
  hotspots: TeamHotspotRow[];
  adoption: { day: string; members: number }[];
  me?: TeamMeVsTeam;
  costModes: Record<TeamCostMode, number>;
  staleMembers: number;
  members: TeamMemberInfo[];
  status: TeamStatus;
}

// ── Run: host Copilot sessions in the app ───────────────────────────────────

import type {
  RunAvailability,
  RunDoor,
  RunEventChange,
  RunPermissionDecision,
  RunPermissionMode,
  RunPrefill,
  RunSessionInfo,
  RunTranscript,
} from './runTypes';

export type {
  RunAvailability,
  RunDoor,
  RunEventChange,
  RunInputRequest,
  RunItem,
  RunLiveState,
  RunPermissionDecision,
  RunPermissionMode,
  RunPermissionRequest,
  RunPrefill,
  RunSessionInfo,
  RunStatus,
  RunTranscript,
} from './runTypes';

/** A checkout the user may start a hosted session in: verified on disk by the datahost. */
export interface RunRepository {
  repository: string;
  /** LOCAL-ONLY display. The datahost re-resolves it; the renderer never sends a path back. */
  cwd: string;
}

/** What a door asks the datahost to prefill. Only ids travel; the text is built host-side. */
export interface RunPrefillParams {
  door: RunDoor;
  source?: string;
  sessionId?: string;
  repository?: string;
  planId?: string;
}

/** How many friction themes the Dashboard's insight card ranks. */
export const INSIGHT_THEME_LIMIT = 8;

/** How many scored hotspots the Dashboard's insight card shows. */
export const INSIGHT_HOTSPOT_LIMIT = 5;

/**
 * One day-and-verdict bucket for the Dashboard hero. `'unjudged'` counts the
 * sessions with no verdict yet — not yet analyzed, or unjudgeable — so the
 * hero's columns always sum to the same sessions the daily chart counts.
 */
export interface VerdictDayPoint {
  /** `YYYY-MM-DD`, local time — the same bucketing as {@link DayPoint}. */
  day: string;
  verdict: RetroVerdict | 'unjudged';
  sessions: number;
}

/**
 * One recurring retrospective finding, ranked by how many sessions raised it.
 * `signalId` is core's stable `RetrospectiveSignalId`; kept as a string so this
 * contract file stays import-free (the datahost's assignment from core's type
 * makes drift a compile error, as with {@link RetroVerdict}).
 */
export interface ThemeRow {
  signalId: string;
  /** Distinct sessions the signal appeared in — the honest recurrence measure. */
  sessions: number;
  /** Total occurrences across those sessions. */
  occurrences: number;
}

/** A hotspot row plus its composite review score (0–100, higher = look first). */
export interface ScoredHotspotRow extends HotspotRow {
  score: number;
}

/**
 * The Dashboard's insight section: how sessions went, what friction recurs, and
 * which context files deserve a look. Separate from {@link OverviewData}
 * because it follows the ANALYSIS pass, not the indexer — it refreshes on
 * `analysis.progress` and carries the coverage note that makes partial results
 * honest.
 */
export interface OverviewInsights {
  /** Sparse day × verdict counts for the window, oldest day first. */
  verdictDaily: VerdictDayPoint[];
  /** Recurring friction themes, most widespread first. */
  themes: ThemeRow[];
  /** Context files ranked by composite score, highest first. */
  hotspots: ScoredHotspotRow[];
  /** Coverage of the analysis behind all three cards. */
  status: AnalysisStatus;
  /** Echoes the request, so the view can drop an answer for a stale window. */
  window: OverviewWindow;
  /** How many day columns `verdictDaily` covers. */
  windowDays: number;
  /** Same meaning as {@link OverviewData.dailyCapped}. */
  dailyCapped?: true;
  /**
   * Evidence summaries for the Dashboard's compact cards. Optional so an older
   * datahost answer still type-checks in a newer renderer during development.
   */
  evidence?: {
    /** Tools with the highest failure rate among those called often enough to judge. */
    tools: { tool: string; calls: number; failures: number }[];
    /** The completion check's counts for the window. */
    completion?: CompletionSummary;
    /** Rework over the window: the rate's two numbers and the top sessions. */
    rework?: { editedSessions: number; reworkedSessions: number; sessions: ReworkSessionRow[] };
  };
}

/** A tool needs at least this many calls in the window before its failure rate is ranked. */
export const TOOL_FAILURE_MIN_CALLS = 10;

/** How many failing tools the Dashboard card lists. */
export const INSIGHT_TOOL_LIMIT = 3;

/** One tool in the Evidence > Tools ranking. A name, counts and durations only. */
export interface ToolRankingRow {
  tool: string;
  calls: number;
  failures: number;
  /** Sessions that called it at least once. */
  sessions: number;
  lastUsedMs: number;
  /** Approximate typical time to result (bucket upper bound); absent with no calls. */
  p50Ms?: number;
  /** Approximate slow time to result. */
  p90Ms?: number;
  /** The slow figure fell past the last bucket: show it as "over N". */
  p90Overflow: boolean;
  /** Longest single call. */
  maxMs: number;
}

/**
 * What the completion check observed about a session that changed code.
 * Mirrors core's `analysis/completionCheck.ts` without `not-applicable`, which
 * never reaches the renderer as a status. Kept local so this file stays
 * import-free.
 */
export type CompletionStatus = 'verified' | 'unverified' | 'contradicted' | 'incomplete';

export const COMPLETION_STATUSES: readonly CompletionStatus[] = ['verified', 'unverified', 'contradicted', 'incomplete'];

/** Thresholds behind the Rework chip, mirrored from core's `analysis/rework.ts` for tooltips. */
export const REWORK_REEDIT_MIN_TURNS = 3;
export const REWORK_LINES_MIN = 30;

/** One session in the Rework ranking. */
export interface ReworkSessionRow {
  source: string;
  sessionId: string;
  repository: string;
  title?: string;
  endedAtMs: number;
  filesReedited: number;
  reworkedLines: number;
  filesEdited: number;
}

/** One file in the Rework ranking. `path` is repository-relative or a bare name, never absolute. */
export interface ReworkFileRow {
  path: string;
  repository: string;
  sessions: number;
  editTurns: number;
  reworkedLines: number;
  outsideRepo: boolean;
}

export interface EvidenceReworkResult {
  /** Sessions in the window that edited any file: the rate's denominator. */
  editedSessions: number;
  reworkedSessions: number;
  sessions: ReworkSessionRow[];
  files: ReworkFileRow[];
  repositories: string[];
  status: AnalysisStatus;
  window: OverviewWindow;
}

/** Completion counts over a window. Every rate uses `changedCode` as its denominator. */
export interface CompletionSummary {
  verified: number;
  unverified: number;
  contradicted: number;
  incomplete: number;
  /** Sessions that changed code and were checked: the sum of the four above. */
  changedCode: number;
  /** Reported done while unverified or with a failed last check. */
  reportedDoneUnverified: number;
}

export interface EvidenceCompletionResult {
  summary: CompletionSummary;
  repositories: string[];
  status: AnalysisStatus;
  window: OverviewWindow;
}

/** The Tools ranking plus how complete the analysis behind it is. */
export interface EvidenceToolsResult {
  rows: ToolRankingRow[];
  /** Repositories the ranking can be narrowed to. */
  repositories: string[];
  status: AnalysisStatus;
  window: OverviewWindow;
}

/**
 * A deep retrospective as the user's own `claude` CLI wrote it. Everything here
 * is model output about LOCAL session content; it is stored only in the local
 * JSON store and never crosses the aggregate/sync path.
 */
export interface DeepRetroVerdict {
  goal?: string;
  outcome?: string;
  narrative?: string;
  promptCritique?: string;
  advice?: string[];
  model: string;
  generatedAtMs: number;
}

/** What a deep-retrospective run produced, or why it could not. */
export interface DeepRetroResult {
  verdict?: DeepRetroVerdict;
  error?: string;
}

/** Whether the ACTIVE AI backend (the user's own AI CLI) can currently serve requests. */
export interface AiAvailability {
  available: boolean;
  /** User-facing explanation when not available. */
  reason?: string;
}

/** One registered AI backend, for the Settings picker and consent copy. */
export interface AiBackendInfo {
  /** Core `BackendId`, e.g. `claude-code` or `copilot-cli`. */
  id: string;
  /** Display name, e.g. "Claude Code". */
  label: string;
  /** The vendor the backend sends content to, for consent copy: "Anthropic" / "GitHub". */
  vendor: string;
  /** This is the backend `ai.*` calls currently route to. */
  active: boolean;
  available: boolean;
  /** User-facing explanation when not available. */
  reason?: string;
}

/** One AI Helper transcript entry as the view renders it. */
export interface AiChatMessage {
  role: 'user' | 'assistant';
  /** The raw text (what was typed, or what the model wrote). */
  text: string;
  /** Host-rendered markup for assistant turns; the renderer owns no markdown parser. */
  html?: string;
}

/** The AI Helper chat as it stands, for a view that just (re)mounted. */
export interface AiChatState {
  messages: AiChatMessage[];
  /** A send is streaming right now; deltas for it carry {@link AiChatState.runId}. */
  busy: boolean;
  /** Increments per send; the view drops deltas from earlier runs. */
  runId: number;
  /** The one-time first-use notice has been accepted. */
  acknowledged: boolean;
  /** Session whose transcript digest is attached to the next send, if any. */
  focus?: SessionRef;
}

/** One AI Helper send: free text, or a quick prompt by id, plus an optional focus session. */
export interface AiSendParams {
  text?: string;
  quickPromptId?: string;
  focus?: SessionRef;
}

/** How a send ended. Error-as-value, mirroring {@link DeepRetroResult} — never a throw across IPC. */
export interface AiSendResult {
  ok: boolean;
  error?: string;
  /** The user pressed Stop; any partial answer was kept in the transcript. */
  cancelled?: boolean;
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
  /** `copilotCli.enabled` — read Copilot CLI sessions from `~/.copilot/session-state`. */
  copilotCliEnabled: boolean;
  /** Directories the Claude scan will actually read (override first; only existing dirs). */
  resolvedClaudeDirs: string[];
  /** True when a non-empty projects-path override does not exist on disk. */
  claudeOverrideMissing: boolean;
  /** Every Copilot database the next index pass will read, in priority order. */
  resolvedCopilotDbs: { path: string; kind: 'archive' | 'native' | 'override' }[];
  /** The locations Copilot auto-detect checks, for explaining "nothing found". */
  copilotScannedPaths: string[];
  /** True when a non-empty sqlitePath override does not exist on disk. */
  sqliteOverrideMissing: boolean;
  /**
   * `deviation.maxSessionMinutes` — how long a single turn may run before the
   * analysis calls it overlong.
   */
  maxSessionMinutes: number;
  /**
   * `retrospective.deepEnabled` — whether the opt-in Deep retrospective button
   * is available. OFF by default: enabling it is the first consent gate for
   * the deep-retrospective flow, which sends session content to Anthropic via
   * the user's own Claude Code CLI login (each run still confirms per session).
   */
  deepRetroEnabled: boolean;
  /**
   * `improve.enabled` — whether Context Improvement Plans can be generated.
   * OFF by default: enabling it is the first consent gate for the third
   * sanctioned exception (each generation still confirms in a dialog).
   */
  improveEnabled: boolean;
  /** `aiHelper.claudeCliPath`; empty string means `claude` on PATH. */
  claudeCliPath: string;
  /** `aiHelper.claudeModel` as the backend will use it (blank resolves to the default alias). */
  claudeModel: string;
  /** `aiHelper.claudeEffort`, clamped to a valid effort level. */
  claudeEffort: string;
  /**
   * `aiHelper.backend` as it will resolve on this machine: which CLI the AI
   * features route through. `claude-code` unless `copilot-cli` was chosen.
   */
  aiBackend: string;
  /** `aiHelper.copilotCliPath`; empty string means `copilot` on PATH. */
  copilotCliPath: string;
  /**
   * `workspace.notifications` — desktop notifications when a live session
   * starts waiting for the user or finishes. OFF by default. Shown by this
   * computer only; nothing is sent anywhere.
   */
  liveNotifications: boolean;
  /**
   * `run.enabled` — whether the app may host GitHub Copilot sessions (Run).
   * OFF by default: turning it on is the first gate; a one-time notice in the
   * view is the second. A hosted session sends the user's message, and what
   * the agent then reads, to GitHub through their own Copilot login.
   */
  runEnabled: boolean;
  /** `run.defaultModel`; empty string means the CLI's own default. */
  runDefaultModel: string;
  /** `packet.includePrompts` — whether a review packet includes the user's own request lines. */
  packetIncludePrompts: boolean;
  /** `team.folder` — the shared folder the Team view reads; '' when unset. */
  teamFolder: string;
  teamFolderExists: boolean;
  /**
   * `team.enabled` — whether the Team view exists at all. OFF by default: the
   * rail entry is hidden, and the team folder is neither read nor written.
   * Turning it off also turns sharing off.
   */
  teamEnabled: boolean;
  /**
   * `team.shareEnabled` — whether this app writes its own shard into the team
   * folder. OFF by default: turning it on is the consent gate for the team
   * shard, which carries the same aggregates as cloud sharing plus per-day
   * session-outcome counts, and nothing else. Reading the folder is on while
   * Team is.
   */
  teamShareEnabled: boolean;
  /** `team.autoExport` — rewrite the shard hourly while the app runs (only when sharing is on). */
  teamAutoExport: boolean;
  /** `team.repositoryMode` — which repositories the shard covers. */
  teamRepositoryMode: 'all' | 'include' | 'exclude';
  teamRepositories: string[];
  /** The viewer's own anonymous id, as it appears in the folder. */
  teamDeveloperId: string;
  /** Absolute path of the desktop config file. */
  configPath: string;
  /** Its directory, for the "open config folder" affordance. */
  configDir: string;
}

/** Most context hotspots one improvement plan may carry (UI and datahost both enforce). */
export const MAX_IMPROVE_HOTSPOTS = 8;

/** Most sessions one improvement plan may carry. */
export const MAX_IMPROVE_SESSIONS = 5;

/** Whether a repository can generate improvement plans, and from what root. */
export interface ImproveRepoStatus {
  repository: string;
  /** The resolved local checkout. LOCAL-ONLY — never leaves this machine. */
  root?: string;
  /** Allowlisted context files found under the root. */
  contextFileCount?: number;
  /** Why generation is blocked, when it is. */
  error?: string;
}

/** What one generation sends: the selected hotspots and sessions, one repository. */
export interface ImproveGenerateParams {
  repository: string;
  /** Hotspot row identities (`HotspotRow.file`) to include as usage statistics. */
  hotspotFiles: string[];
  /** Sessions whose retrospective evidence to include. */
  sessions: SessionRef[];
}

/** One proposed edit as the renderer sees it — content stays datahost-side. */
export interface ImprovePlanEditView {
  path: string;
  action: 'replace' | 'create';
  rationale?: string;
  appliedAtMs?: number;
  revertedAtMs?: number;
  /** An applied, since-untouched file this plan still holds a backup for. */
  canUndo: boolean;
}

/** A stored improvement plan, rendered for display. */
export interface ContextPlanView {
  id: string;
  repository: string;
  createdAtMs: number;
  backendLabel: string;
  /** The vendor the generation was sent to — part of the record, not just the dialog. */
  vendor: string;
  model: string;
  /** Host-rendered markdown (the renderer owns no markdown parser). */
  narrativeHtml: string;
  summary?: string;
  /** Proposals the validator dropped — shown honestly, never silently. */
  invalidEditCount: number;
  edits: ImprovePlanEditView[];
}

/** One row of the plan history list. */
export interface ContextPlanSummary {
  id: string;
  repository: string;
  createdAtMs: number;
  backendLabel: string;
  summary?: string;
  editCount: number;
  appliedCount: number;
}

/** Error-as-value, like {@link DeepRetroResult}. */
export interface ImproveGenerateResult {
  plan?: ContextPlanView;
  error?: string;
}

/** One display line of a file diff; `fold` compresses an unchanged run. */
export interface FileDiffLine {
  kind: 'same' | 'add' | 'del' | 'fold';
  /** Absent on folds. */
  text?: string;
  /** Folded line count; absent otherwise. */
  count?: number;
}

/** A proposed edit diffed against the file as it is on disk RIGHT NOW. */
export interface FileDiffResult {
  lines: FileDiffLine[];
  /** The file no longer matches what the plan was generated from. */
  stale: boolean;
  /** A `replace` target that has vanished from disk. */
  missing: boolean;
  error?: string;
}

/** Per-file outcome of an apply or undo. */
export interface ApplyFileResult {
  path: string;
  ok: boolean;
  status: 'applied' | 'stale' | 'missing' | 'refused' | 'error' | 'reverted';
  detail?: string;
}

export interface ApplyResult {
  results: ApplyFileResult[];
  /** A whole-request refusal (gate off, plan unknown, root gone). */
  error?: string;
}

/** Partial settings update; omitted fields are untouched. `''` clears a path override. */
export interface SettingsPatch {
  claudeEnabled?: boolean;
  claudeProjectsPath?: string;
  copilotEnabled?: boolean;
  copilotCliEnabled?: boolean;
  sqlitePath?: string;
  maxSessionMinutes?: number;
  deepRetroEnabled?: boolean;
  improveEnabled?: boolean;
  claudeCliPath?: string;
  claudeModel?: string;
  claudeEffort?: string;
  /** Which CLI the AI features route through. */
  aiBackend?: 'claude-code' | 'copilot-cli';
  copilotCliPath?: string;
  liveNotifications?: boolean;
  runEnabled?: boolean;
  runDefaultModel?: string;
  packetIncludePrompts?: boolean;
  teamEnabled?: boolean;
  /** '' clears the folder. */
  teamFolder?: string;
  teamShareEnabled?: boolean;
  teamAutoExport?: boolean;
  teamRepositoryMode?: 'all' | 'include' | 'exclude';
  teamRepositories?: string[];
}

/**
 * The VS Code setting that makes Copilot Chat write `agent-traces.db`. Off by
 * default — which is why a machine can use Copilot daily and hold no database.
 * Lives here rather than in core's paths module so the renderer can show it
 * without pulling node imports into its bundle.
 */
export const COPILOT_TRACE_SETTING = 'github.copilot.chat.otel.dbSpanExporter.enabled';

/**
 * Per-editor state of the VS Code setting that makes Copilot Chat write its
 * trace database. Only 'unset', 'disabled' and 'no-settings-file' are fixable
 * by {@link RpcMethods['copilot.enableTracing']}; the last two states get
 * manual instructions instead.
 */
export type CopilotTraceState =
  | 'enabled' // key present and true
  | 'unset' // settings.json parses, key absent (VS Code default: off)
  | 'disabled' // key explicitly false — a user decision, changed only with consent
  | 'no-settings-file' // editor evidenced but no settings.json; fixable by creating one
  | 'unparseable' // JSONC too broken to edit safely
  | 'denied'; // no permission to read the file

/** One VS Code-family editor and where its trace-exporter setting stands. */
export interface CopilotSetupTarget {
  /** Raw variant directory name ('Code', 'Cursor', …). */
  variant: string;
  /** Display name ('VS Code', 'VS Code Insiders', else the raw name). */
  variantLabel: string;
  /** Absolute path of the editor's `User/settings.json`. */
  settingsFile: string;
  state: CopilotTraceState;
  /** The editor's `agent-traces.db` already exists — tracing has produced data. */
  dbExists: boolean;
  /** Error text for 'unparseable' / 'denied'. */
  detail?: string;
}

/** The whole Copilot-tracing setup picture, ready for either consent surface. */
export interface CopilotSetupStatus {
  targets: CopilotSetupTarget[];
  /** The Copilot source toggle in THIS app (`localTelemetry.enabled`). */
  copilotSourceEnabled: boolean;
  /** The startup prompt was dismissed on some earlier launch (persisted). */
  promptDismissed: boolean;
  /** Datahost verdict: the startup prompt belongs on screen this launch. */
  shouldPrompt: boolean;
}

/** Outcome of one settings.json write, error-as-value like `sessions.delete`. */
export interface EnableTracingTargetResult {
  settingsFile: string;
  ok: boolean;
  detail: string;
}

export interface EnableTracingResult {
  results: EnableTracingTargetResult[];
  /** Status re-checked after the writes, so one round trip updates the UI. */
  status: CopilotSetupStatus;
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
   * The facts behind one Context Analysis section (0 = the total, i = the
   * i-th agent), for the "Improve context files" prompt. Read from the same
   * analysis the open document shows; `undefined` when the session has none or
   * the section does not exist. The renderer builds the prompt locally —
   * nothing is sent anywhere.
   */
  'sessions.contextPrompt'(source: string, sessionId: string, section: number): ContextPromptFacts | undefined;
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
  /**
   * Replace a session's tags, or clear them with an empty array. Normalized on
   * the way in — trimmed, de-duplicated case-insensitively, capped — so the
   * caller does not have to. Returns the row as it now reads.
   */
  'sessions.setTags'(source: string, sessionId: string, tags: string[]): SessionRow | undefined;
  /** Attach a note, or clear it with an empty string. Returns the updated row. */
  'sessions.setNote'(source: string, sessionId: string, note: string): SessionRow | undefined;
  /**
   * A session's note text, empty when there is none. Fetched per session rather
   * than carried on every list row, which only needs to know one exists.
   */
  'sessions.note'(source: string, sessionId: string): string;
  /** Every tag in use with its session count, for the filter and the picker. */
  'tags.list'(): TagCount[];
  'overview.get'(params?: { window?: OverviewWindow }): OverviewData;
  /**
   * The Dashboard's insight section — verdict trend, recurring friction themes,
   * scored hotspots — over the same window as {@link RpcMethods['overview.get']}
   * but refreshed on `analysis.progress`, because everything in it comes from
   * the background analysis rather than the indexer.
   */
  'overview.insights'(params?: { window?: OverviewWindow }): OverviewInsights;
  /**
   * The Context Hotspots ranking, aggregated in SQL over what the background
   * analysis has read so far. Returns the ranking it can build right now plus
   * its progress, so the view can show partial results honestly instead of an
   * empty screen while the first pass runs.
   */
  'hotspots.get'(params?: { repository?: string }): HotspotsResult;
  /** The sessions behind one hotspot row, newest first. */
  'hotspots.sessions'(file: string, params?: { repository?: string }): HotspotSessionRow[];
  /**
   * The Retro ranking — every judged session, worst first — aggregated in SQL
   * over what the background analysis has read so far, with the same
   * partial-results honesty as the hotspots ranking.
   */
  'retro.get'(params?: { repository?: string }): RetroResult;
  /**
   * Per-tool call volume, failures and time to result over the analyzed
   * sessions in scope. Local-only; a tool name is the only string involved.
   */
  'evidence.tools'(params?: { window?: OverviewWindow; source?: string; repository?: string }): EvidenceToolsResult;
  /** Completion-check counts for the window: what was and was not observed after the last edit. */
  'evidence.completion'(params?: { window?: OverviewWindow; source?: string; repository?: string }): EvidenceCompletionResult;
  /** The Rework ranking: a proxy for thrashing, never a quality score. Paths are display paths. */
  'evidence.rework'(params?: { window?: OverviewWindow; source?: string; repository?: string }): EvidenceReworkResult;
  /**
   * Run the opt-in Deep retrospective for one session: build a transcript
   * digest, ask the user's own `claude` CLI to judge it, store the verdict in
   * the local JSON store, and return it. Gated twice — the settings toggle and
   * a per-invocation confirmation the RENDERER must show before calling this;
   * the datahost additionally refuses when the toggle is off.
   */
  'retro.deep'(source: string, sessionId: string): DeepRetroResult;
  /** Progress of the background analysis pass. */
  'analysis.status'(): AnalysisStatus;
  /**
   * Whether the AI backend (the user's own `claude` CLI) can serve requests.
   * Cheap: a missing binary fails its probe instantly, and a working one is
   * cached — call freely from any surface that needs the CLI.
   */
  'ai.availability'(): AiAvailability;
  /**
   * Every registered AI backend with its availability, the active one marked.
   * Backs the Settings backend picker and lets consent surfaces name the
   * vendor a send would actually go to.
   */
  'ai.backends'(): AiBackendInfo[];
  /** The AI Helper chat as it stands, for a view that just (re)mounted. */
  'ai.state'(): AiChatState;
  /**
   * Send one AI Helper message. Grounding (recent-session summary, plus the
   * focus session's transcript digest when one is attached) is assembled here
   * and streamed through the user's own `claude` CLI; the answer arrives as
   * `ai.assistantDelta` events and the returned promise settles when the
   * stream ends. Refused until the first-use notice is acknowledged — the
   * datahost enforces the gate independently of the renderer.
   */
  'ai.send'(params: AiSendParams): AiSendResult;
  /** Cancel the in-flight send, keeping any partial answer in the transcript. */
  'ai.stop'(): void;
  /** Start a new chat: clears the in-memory thread and any focus session. */
  'ai.reset'(): void;
  /** Record that the user accepted the one-time first-use notice. */
  'ai.acknowledge'(): void;
  /**
   * Whether a repository can generate improvement plans: is a local checkout
   * known, and does it still resolve to this repository. Read-only and cheap.
   */
  'improve.repoStatus'(repository: string): ImproveRepoStatus;
  /**
   * Generate one Context Improvement Plan. THE THIRD SANCTIONED EXCEPTION:
   * sends the selected hotspot statistics, the selected sessions'
   * retrospective evidence (titles and goals included), and the repository's
   * context-file CONTENTS to the active backend's vendor through the user's
   * own CLI login. Gated twice — the default-off Settings toggle and the
   * per-generation dialog the RENDERER must show before calling this; the
   * datahost additionally refuses when the toggle is off.
   */
  'improve.generate'(params: ImproveGenerateParams): ImproveGenerateResult;
  /** Stored plans, newest first, optionally narrowed to one repository. */
  'improve.plans'(repository?: string): ContextPlanSummary[];
  /** One stored plan, rendered for display. */
  'improve.plan'(id: string): ContextPlanView | undefined;
  /**
   * Diff one proposed edit against the file as it stands on disk — which makes
   * the preview double as a live staleness probe.
   */
  'improve.diff'(id: string, path: string): FileDiffResult;
  /**
   * Write the approved edits into the repository. The product's ONE sanctioned
   * write path into user repos: allowlisted context files under the resolved
   * root only, staleness-checked against the generation, backed up before the
   * first byte is written, and never deleting anything. Call only after the
   * per-file preview and approval; the datahost re-validates everything.
   */
  'improve.apply'(id: string, paths: string[]): ApplyResult;
  /** Restore applied files from their backups (refused after outside edits). */
  'improve.undo'(id: string, paths: string[]): ApplyResult;
  /** The editable settings plus what auto-detection currently resolves to. */
  /** The live board: sessions active in the last 30 minutes, with derived status. */
  'workspace.live'(): LiveBoardSnapshot;
  /** One card per repository active in the window, with live counts folded in. */
  'workspace.repositories'(params?: { window?: OverviewWindow }): RepositoryCards;
  /** Everything the repository hub shows, in one call. */
  'workspace.repoHub'(repository: string, params?: { window?: OverviewWindow }): RepoHubData;
  /**
   * The input for the locally built digest. The renderer renders it with
   * core's pure digest module; nothing here leaves the machine and no vendor
   * is called.
   */
  'workspace.repoDigest'(repository: string, params?: { window?: OverviewWindow }): RepositoryDigestInput;
  /** Folder, sharing and export state of the Team feature. */
  'team.status'(): TeamStatus;
  /** Re-read the folder now. */
  'team.refresh'(): TeamStatus;
  /** The exact JSON sharing would write. Allowed whether or not sharing is on: previewing is not sharing. */
  'team.preview'(): TeamPreview;
  /** Write this member's shard now. Refused in the datahost unless sharing is on and consented. */
  'team.exportNow'(): TeamExportResult;
  /** Everything the Team view draws, over the merged shards. */
  'team.view'(params?: { window?: TeamWindow }): TeamViewData;
  'team.members'(): TeamMemberInfo[];
  /** What needs the developer now, and what finished since they last looked. */
  'inbox.list'(params?: { includeDismissed?: boolean }): InboxSnapshot;
  /** Change the state of some items, or all visible ones. `'new'` undoes a dismiss. */
  'inbox.mark'(
    keys: string[] | 'all',
    state: 'seen' | 'dismissed' | 'snoozed' | 'new',
    params?: { untilMs?: number },
  ): InboxSnapshot;
  /**
   * The structured review packet for one or more sessions (at most
   * {@link MAX_COMPARE_SESSIONS}). Built locally with no AI; the renderer
   * turns it into Markdown and the user copies it.
   */
  'sessions.reviewPacket'(refs: SessionRef[]): ReviewPacketResult;
  /** A continuation brief for starting the next session where this one stopped. */
  'sessions.handoffBrief'(source: string, sessionId: string): { brief: HandoffBrief; note?: string };
  /** Where and with which CLI this session can be resumed in the user's terminal. */
  'sessions.handoff'(source: string, sessionId: string): ResumeTarget;
  /** Whether Run can be used on this machine, and the models it may pick. */
  'run.availability'(): RunAvailability;
  /** Record that the user read the Run notice. The only way `run.disclosed` is set. */
  'run.acknowledge'(): RunAvailability;
  'run.repositories'(): RunRepository[];
  /** Start a hosted session. The datahost resolves and verifies the checkout itself. */
  'run.start'(params: {
    goal: string;
    repository: string;
    model?: string;
    door: RunDoor;
    permissionMode?: RunPermissionMode;
  }): RunSessionInfo;
  /** Continue a Copilot CLI session in the app; its directory is read from the session's own record. */
  'run.resume'(sessionId: string): RunSessionInfo;
  'run.send'(sessionId: string, text: string): void;
  'run.abort'(sessionId: string): void;
  'run.close'(sessionId: string): void;
  'run.list'(): RunSessionInfo[];
  'run.transcript'(sessionId: string): RunTranscript | undefined;
  'run.permission.respond'(requestId: string, decision: RunPermissionDecision, feedback?: string): void;
  'run.input.respond'(requestId: string, answer?: string): void;
  /** Switch one hosted session between asking before each action and Allow all. In memory only. */
  'run.permissionMode'(sessionId: string, mode: RunPermissionMode): RunSessionInfo;
  /** Text for the goal box, built host-side from what the app already knows. Nothing is sent. */
  'run.prefill'(params: RunPrefillParams): RunPrefill;
  'settings.get'(): SettingsSnapshot;
  /**
   * Persist a partial settings update. Sources whose settings changed are
   * re-indexed automatically; the returned snapshot reflects the new state.
   */
  'settings.update'(patch: SettingsPatch): SettingsSnapshot;
  /**
   * Per-editor state of the Copilot trace-exporter setting. Read-only and
   * cheap — a few file stats plus JSONC parses — so re-check freely.
   */
  'copilot.setupStatus'(): CopilotSetupStatus;
  /**
   * Write the trace-exporter setting into the given editors' settings.json
   * files (comments preserved). Call only after the user consented — the
   * startup prompt or the Settings button. Paths are validated against the
   * datahost's own target list; arbitrary paths are refused.
   */
  'copilot.enableTracing'(settingsFiles: string[]): EnableTracingResult;
  /** Persist that the startup setup prompt should not be shown again. */
  'copilot.dismissSetupPrompt'(): void;
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
  | { event: 'analysis.progress'; status: AnalysisStatus }
  /**
   * The in-flight AI Helper answer so far, host-rendered to HTML. Each tick
   * carries the WHOLE accumulated answer, so the view replaces rather than
   * appends and a dropped event can never corrupt the markup.
   */
  | { event: 'ai.assistantDelta'; runId: number; html: string }
  /** The live board changed: a session appeared, changed status, or finished. */
  | { event: 'workspace.live'; snapshot: LiveBoardSnapshot }
  /** The inbox changed: an item appeared, cleared, or changed state. */
  | { event: 'inbox.changed'; snapshot: InboxSnapshot }
  /** A hosted session changed: status, a transcript item, a permission request. */
  | { event: 'run.event'; sessionId: string; change: RunEventChange }
  /** How many hosted sessions are running, so main can confirm before quitting. */
  | { event: 'run.active'; count: number }
  /** The team folder was re-read or this member's shard was written. */
  | { event: 'team.changed'; status: TeamStatus };

export type RpcEventName = RpcEvent['event'];

/** Stable identity for a session row across sources. */
export function sessionKey(source: string, sessionId: string): string {
  return `${source}:${sessionId}`;
}
