import type { SessionDetail, SessionTurn } from '../telemetry/models';

/**
 * Session Retrospective — a local, heuristic answer to the questions a
 * developer actually asks after an agent run: what was the goal, does it look
 * fulfilled, where was the friction, was the opening prompt any good, and what
 * is worth trying differently next time.
 *
 * Everything here is a PROXY, and the module is honest about that in three
 * structural ways:
 * - The verdict is ordinal ({@link SessionVerdict}), never a numeric score —
 *   a 0-100 number would imply precision these heuristics do not have.
 * - `unclear` is a first-class {@link SessionOutcome}: friction is observable
 *   from a transcript, correctness is not, and the honest default when neither
 *   success nor abandonment is evident is to say so.
 * - Signals that are legitimate strategies rather than failures (long
 *   autonomous turns, sub-agent fan-out, skipping plan mode) are `info`
 *   severity and NEVER move the verdict; they exist to power advice, not blame.
 *
 * PRIVACY: the whole {@link SessionRetrospective} is content-derived and
 * LOCAL-ONLY — the same class as `SessionTurn.userRequest`. Finding
 * descriptions are generic sentences that never embed prompt/response text
 * (evidence is referenced by turn index; the local UI already holds the raw
 * turn content if it wants to show it). The {@link RetrospectiveCounts}
 * projection is numbers and enum labels only, safe for the desktop's local
 * `index.db`, but still content-derived: nothing from this module may ever
 * reach the aggregate/sync paths, mirroring `WorkflowDeviation.contentDerived`.
 *
 * Correction matching is plain lowercase `startsWith`/`includes` over a capped
 * window of static in-code phrases — no user-supplied regex, so the ReDoS
 * guards in `../deviation/contentMatcher.ts` are not needed here.
 *
 * This module depends only on `../telemetry/models` (like `../deviation/`), so
 * it applies to every source: Claude sessions pass transcript-only
 * {@link RetrospectiveSignals} extracted by `../claude/retrospectiveSignals`;
 * a source without them simply omits the argument and those signals degrade to
 * absent rather than wrong.
 */

// ── Thresholds ──────────────────────────────────────────────────────────────
// Exported so tests and the calibration probe can reference them. Deliberately
// constants rather than config keys: tune against the real corpus first (see
// docs/proposals/09-session-retrospective.md), add knobs only if that shows
// per-user variance actually matters.

/** Only the head of a follow-up prompt is scanned for correction phrasing. */
export const CORRECTION_SCAN_CHARS = 240;
/** A follow-up at most this long is judged as a whole (ack vs. rejection). */
export const SHORT_FOLLOW_UP_MAX_CHARS = 25;
/**
 * Token-set Jaccard similarity at/above which a later prompt is a re-ask.
 * Calibrated against the real corpus: 0.6 flagged ordinary iterative work
 * ("now the same for the settings page") several times per session.
 */
export const REPEAT_SIMILARITY_MIN = 0.75;
/** Prompts with fewer distinct tokens than this are too small to compare. */
export const REPEAT_MIN_TOKENS = 8;
/** O(n²) prompt comparison is capped to the first N prompts. */
export const MAX_COMPARED_TURNS = 50;
/** All prompt-text scans read at most this many characters. */
export const MAX_PROMPT_SCAN_CHARS = 4000;
/** Consecutive failed tool events at/above this length form a streak. */
export const ERROR_STREAK_MIN = 3;
/** A streak at/above this length alone marks the session as struggled. */
export const ERROR_STREAK_STRUGGLE = 5;
/** removed/added code-line ratio at/above which the session churned. */
export const CHURN_RATIO_MIN = 0.5;
/** Churn is only meaningful once the session wrote at least this much code. */
export const CHURN_MIN_LINES_ADDED = 50;
/** A turn with at least this much ACTIVE event time is a long-tail turn (10 min). */
export const LONG_TURN_MS = 600_000;
/**
 * Each event contributes at most this much (5 min) to a turn's active time.
 * A Claude chat event's duration is the gap since the previous record, so an
 * overnight pause would otherwise read as a 700-minute "turn" — idle time, not
 * work. The clamp keeps single gaps from dominating while genuinely long
 * autonomous turns (many medium events) still cross {@link LONG_TURN_MS}.
 */
export const LONG_EVENT_CLAMP_MS = 300_000;
/** Compactions at/above this count become friction (one is just a long run). */
export const COMPACTION_FRICTION_MIN = 2;
/** Sub-agent share of tree tokens at/above which the session is fan-out-heavy. */
export const SUBAGENT_TOKEN_SHARE_MIN = 0.6;
/** Sub-agent LLM calls at/above this count also qualify as fan-out-heavy. */
export const SUBAGENT_CALLS_MIN = 25;
/** Fan-out share is only judged once the tree spent at least this many tokens. */
export const SUBAGENT_MIN_TOTAL_TOKENS = 100_000;
/** Plan-mode advice fires only for sessions that wrote at least this much code… */
export const PLAN_ADVICE_MIN_LINES = 300;
/** …across at least this many writing turns. */
export const PLAN_ADVICE_MIN_TURNS = 3;
/** An opening prompt shorter than this with ≤1 specificity marker is vague. */
export const VAGUE_PROMPT_MAX_CHARS = 80;
/** Marker categories at/above this count rate the opening prompt specific. */
export const SPECIFIC_MARKERS_MIN = 2;
/** An opening prompt longer than this is oversized (likely multi-goal). */
export const OVERSIZED_PROMPT_CHARS = 3000;
/** …or one with at least this many list/imperative lines. */
export const OVERSIZED_GOAL_LINES = 8;
/** At most this many tips are emitted, highest-priority first. */
export const MAX_TIPS = 3;
/**
 * A session whose last activity is younger than this is not judged abandoned:
 * it may simply still be running (the desktop indexes live transcripts), and a
 * transient "Left unfinished" on an active session would be wrong more often
 * than useful. The analysis is recomputed when the transcript changes, so a
 * genuinely abandoned session earns the verdict once the grace expires.
 */
export const RECENT_ACTIVITY_GRACE_MS = 5 * 60_000;

/**
 * The literal prefix Claude Code writes into a user record when the user hits
 * Esc mid-run (both the bare form and `… for tool use]`). An implementation
 * detail of Claude Code, so matching is by prefix and absence fails quiet.
 * These records pass the mapper's `isUserRequest`, so they ALSO surface as
 * turns whose `userRequest` is this text — {@link isInterruptionText} is how
 * this module tells those apart from genuine prompts.
 */
export const INTERRUPTION_PREFIX = '[Request interrupted by user';

/** Whether a prompt/record text is Claude Code's interruption marker. */
export function isInterruptionText(text: string): boolean {
  return text.trimStart().toLowerCase().startsWith(INTERRUPTION_PREFIX.toLowerCase());
}

/**
 * Slash-command bookkeeping Claude Code writes as user records
 * (`<command-name>/clear</command-name>…`, `<local-command-stdout>`). These
 * pass the mapper's turn anchor too, so without this check a session that ends
 * with `/clear` reads as "final prompt never answered" — the single largest
 * false-abandonment class the calibration probe found (see proposal 09).
 */
const COMMAND_PREFIXES = ['<command-name>', '<command-message>', '<local-command-stdout>'];

/** Whether a prompt/record text is slash-command bookkeeping, not a prompt. */
export function isCommandText(text: string): boolean {
  const head = text.trimStart().toLowerCase();
  return COMMAND_PREFIXES.some((p) => head.startsWith(p));
}

// ── Output model ────────────────────────────────────────────────────────────

/**
 * Ordinal session-quality verdict. Deliberately NOT a numeric score: the
 * heuristics are coarse proxies and a 0-100 number would imply precision they
 * do not have. `abandoned` means "left unfinished", not "failed" — a user may
 * walk away from a session precisely because it already gave them enough.
 */
export type SessionVerdict = 'smooth' | 'bumpy' | 'struggled' | 'abandoned';

/**
 * Whether the stated goal appears to have been reached. `unclear` is the
 * honest default — these heuristics observe friction, not correctness.
 */
export type SessionOutcome = 'likely-fulfilled' | 'partially' | 'unclear' | 'likely-unfulfilled';

/** How the opening prompt reads, judged by shape alone. */
export type PromptRating = 'vague' | 'adequate' | 'specific' | 'oversized';

/** Where the session's goal statement came from. */
export type GoalSource = 'ai-title' | 'summary' | 'first-prompt' | 'none';

/** How much to trust the goal statement. */
export type GoalConfidence = 'high' | 'medium' | 'low';

/**
 * Stable finding ids. Persisted indirectly (tips cite them) and rendered by
 * hosts — never rename an existing member.
 */
export type RetrospectiveSignalId =
  | 'correction-reprompt'
  | 'repeated-prompt'
  | 'user-interruption'
  | 'tool-error-streak'
  | 'rework-churn'
  | 'long-tail-turn'
  | 'context-compaction'
  | 'subagent-heavy'
  | 'plan-mode-skipped'
  | 'vague-first-prompt'
  | 'oversized-first-prompt'
  | 'abandoned-ending';

/** Specificity marker categories detected in the opening prompt. */
export type PromptMarker =
  | 'file-path'
  | 'code-span'
  | 'imperative-verb'
  | 'acceptance-criteria'
  | 'constraints'
  | 'list-structure';

/** One observed moment/pattern, tied to its evidence by turn index. */
export interface RetrospectiveFinding {
  id: RetrospectiveSignalId;
  /**
   * `info` findings are context and never move the verdict; `friction`
   * findings count toward it; a `blocker` decides it on its own.
   */
  severity: 'info' | 'friction' | 'blocker';
  /**
   * Generic human-readable sentence. MUST NOT embed raw prompt/response/tool
   * text — evidence is referenced via {@link turnIndex} and the local UI
   * already holds the raw turn content if it wants to show it.
   */
  description: string;
  /** Index into `SessionDetail.turns` when the evidence is one turn. */
  turnIndex?: number;
  /** Signal magnitude: a count, streak length, or ratio ×100 per detector. */
  value?: number;
  /**
   * `true` when prompt/response TEXT contributed to the finding; `false` for
   * pure metadata signals (streaks, durations, token shares). Mirrors
   * `WorkflowDeviation.contentDerived` semantics.
   */
  contentDerived: boolean;
}

/** Shape assessment of the opening prompt (the goal statement). */
export interface PromptAssessment {
  chars: number;
  words: number;
  /** Which specificity marker categories were present. */
  markers: PromptMarker[];
  rating: PromptRating;
}

/** One evidence-backed suggestion from the static advice table. */
export interface RetrospectiveTip {
  /** Stable id from {@link ADVICE_RULES} — never rename an existing one. */
  id: string;
  /** The advice sentence. Addresses the setup, never the user's competence. */
  text: string;
  /** The finding ids that triggered it — every tip is evidence-backed. */
  evidence: RetrospectiveSignalId[];
}

/**
 * Compact numeric projection safe for the desktop's LOCAL `index.db`: counts,
 * enum labels and booleans only — no strings of user content. Still
 * content-derived and LOCAL-ONLY: these numbers must never reach the
 * aggregate/sync paths, exactly like deviation counts today.
 */
export interface RetrospectiveCounts {
  verdict: SessionVerdict;
  outcome: SessionOutcome;
  /** Follow-up prompts that read as corrections of the previous turn. */
  correctionTurns: number;
  /** Later prompts that near-duplicate an earlier one. */
  repeatedPromptTurns: number;
  /** Times the user interrupted the agent mid-run. */
  interruptions: number;
  /** Number of failed-tool streaks (length ≥ {@link ERROR_STREAK_MIN}). */
  errorStreaks: number;
  /** Length of the longest failed-tool streak (0 when none). */
  maxErrorStreak: number;
  /** Turns whose events spanned at least {@link LONG_TURN_MS}. */
  longTailTurns: number;
  /** Context compactions observed (0 when the source cannot know). */
  compactions: number;
  /**
   * Gross code churn ratio ×100 (removed / max(1, added)), or 0 when the
   * session wrote fewer than {@link CHURN_MIN_LINES_ADDED} code lines — below
   * that the ratio is noise, not signal.
   */
  churnRatioPct: number;
  /** Whether plan mode was used (false also when the source cannot know). */
  planModeUsed: boolean;
  /** Absent when the session had no genuine opening prompt to judge. */
  firstPromptRating?: PromptRating;
  tipCount: number;
}

/**
 * Slot for the OPT-IN deep-retrospective tier: a judgement written by the
 * user's own local `claude` CLI. The heuristic engine NEVER populates this; it
 * exists so a host can attach a model-written verdict without a schema change.
 * LOCAL-ONLY, and produced only behind the double consent gate described in
 * docs/proposals/09-session-retrospective.md.
 */
export interface RetrospectiveLlmVerdict {
  goal?: string;
  outcome?: SessionOutcome;
  /** The model's short narrative of how the session went. */
  narrative?: string;
  /** The model's read on the opening prompt. */
  promptCritique?: string;
  advice?: string[];
  model: string;
  generatedAtMs: number;
}

/**
 * LOCAL-ONLY session retrospective. The whole object is content-derived (the
 * goal text, the prompt-pattern findings) and must never cross the
 * aggregate/sync paths — same privacy class as `SessionTurn.userRequest`.
 */
export interface SessionRetrospective {
  sessionId: string;
  /**
   * What the session set out to do — the resolved title (`ai-title` when
   * Claude wrote one, else derived from the first prompt). LOCAL-ONLY raw
   * content, exactly like `SessionSummary.title` which it copies.
   */
  goal?: string;
  goalSource: GoalSource;
  goalConfidence: GoalConfidence;
  verdict: SessionVerdict;
  /** Finding ids that decided the verdict, so the UI can explain it. */
  verdictReasons: RetrospectiveSignalId[];
  outcome: SessionOutcome;
  /** Sorted blockers first, then friction, then info; by turn within a tier. */
  findings: RetrospectiveFinding[];
  /** Absent when the session had no genuine opening prompt. */
  firstPrompt?: PromptAssessment;
  tips: RetrospectiveTip[];
  counts: RetrospectiveCounts;
  /** Whole-object marker mirroring `WorkflowDeviation.contentDerived`. */
  contentDerived: true;
  llmVerdict?: RetrospectiveLlmVerdict;
}

/**
 * Transcript-only signals no `SessionDetail` field carries today, extracted by
 * `../claude/retrospectiveSignals` (the content chokepoint: records in,
 * counts/enums out). A source that cannot produce them omits the argument and
 * the dependent findings simply do not fire — absent, never wrong.
 */
export interface RetrospectiveSignals {
  /** User records matching {@link INTERRUPTION_PREFIX} (both variants). */
  interruptionCount: number;
  /** The last substantive record was an interruption. */
  endedWithInterruption: boolean;
  /** `system` records with subtype `compact_boundary`. */
  compactionCount: number;
  /** Any plan-mode record or per-record `permissionMode === 'plan'` stamp. */
  planModeUsed: boolean;
  /** Assistant records flagged as API error messages. */
  apiErrorCount: number;
  /** What the transcript's final substantive record was. */
  lastEvent: 'assistant-response' | 'user-request' | 'interruption' | 'tool-result' | 'unknown';
}

// ── Correction / acknowledgment phrase tables (static, lowercase) ───────────

/**
 * Whole-prompt acknowledgments — a short follow-up matching one of these is
 * the user saying "go on", never a correction, even though several start with
 * "no". Checked FIRST, before any marker.
 */
const ACKNOWLEDGMENTS = new Set([
  'yes', 'y', 'yep', 'yeah', 'ok', 'okay', 'k', 'go', 'go ahead', 'continue',
  'proceed', 'do it', 'sounds good', 'looks good', 'lgtm', 'thanks',
  'thank you', 'ty', 'approve', 'approved', 'sure', 'no problem', 'no worries',
  '1', '2', '3', '4', 'a', 'b', 'c', 'd',
]);

/**
 * Phrases that mark a correction when they LEAD the prompt. Leading position
 * is the load-bearing precision rule: "actually" or "instead" mid-sentence is
 * ordinary steering, but a prompt that OPENS by negating is a rejection of
 * what just happened. "wait"/"stop" require punctuation or whole-prompt form
 * (below) so "stop the server" — a task, not a correction — stays unmatched.
 */
const LEADING_CORRECTION_MARKERS = [
  'no ', 'no,', 'no.', 'nope', "that's not", 'thats not', 'that is not',
  "that's wrong", 'wrong ', 'wrong,', 'wrong.', 'actually', 'instead',
  'wait,', 'wait.', 'wait -', 'stop,', 'stop.',
];

/** Whole-prompt forms of the leading markers. */
const WHOLE_PROMPT_CORRECTIONS = new Set(['no', 'stop', 'wait', 'wrong']);

/** Phrases that mark a correction anywhere in the scanned window. */
const ANYWHERE_CORRECTION_MARKERS = [
  "that's wrong", 'that is wrong', 'still broken', 'still failing',
  'still not work', "doesn't work", 'does not work', "didn't work",
  'did not work', 'not what i', 'you missed', 'you broke', 'wrong file',
  'wrong place', 'try again', 'start over',
];

/**
 * Undo phrases count as corrections ONLY when an earlier turn actually wrote
 * lines — "revert commit abc123" as the task itself must not match.
 */
const UNDO_MARKERS = ['undo', 'revert', 'roll back', 'rollback'];

/** Opening words that read as a concrete task statement. */
const IMPERATIVE_VERBS = new Set([
  'add', 'fix', 'implement', 'create', 'write', 'refactor', 'update', 'remove',
  'rename', 'investigate', 'debug', 'migrate', 'convert', 'test', 'document',
  'design', 'build', 'make', 'change', 'extend', 'wire', 'hook', 'analyze',
  'review', 'optimize', 'improve', 'replace', 'move', 'split', 'merge',
]);

const ACCEPTANCE_MARKERS = ['should ', 'so that', 'expected', 'acceptance', 'must ', 'verify'];
const CONSTRAINT_MARKERS = ["don't", 'do not', 'avoid', 'never ', 'only ', 'without '];

/** A path-separator run or a recognizable source-file extension. */
const FILE_PATH_RE = /[\w.-]+[\\/][\w.\\/-]+/;
const FILE_EXT_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|cs|java|rb|go|rs|css|scss|html|json|md|yml|yaml|sql|sh|ps1|txt|xml|toml|c|h|cpp|hpp)\b/;
const LIST_LINE_RE = /^\s*(?:[-*•]|\d+[.)])\s/;

// ── Advice table ────────────────────────────────────────────────────────────

interface AdviceRule {
  id: string;
  /** Finding ids that must ALL be present for the rule to fire… */
  requires: RetrospectiveSignalId[];
  /** …plus an optional structured condition over the counts. */
  when?: (c: RetrospectiveCounts) => boolean;
  /** Lower runs first; {@link MAX_TIPS} caps the output. */
  priority: number;
  text: (c: RetrospectiveCounts) => string;
}

/**
 * The static advice table. Tone rule: every tip addresses the SETUP — the
 * prompt, the session shape, the captured context — never the user's
 * competence, and always cites the findings that triggered it.
 */
export const ADVICE_RULES: readonly AdviceRule[] = [
  {
    id: 'restate-goal-after-abandon',
    requires: ['abandoned-ending'],
    priority: 1,
    text: () =>
      'The session trailed off without a wrap-up. If the task stalled, a fresh session that ' +
      'restates the goal plus what this one learned usually beats pushing a long stalled ' +
      'session further — its context has already degraded.',
  },
  {
    id: 'vague-prompt-confirmed',
    requires: ['vague-first-prompt', 'correction-reprompt'],
    when: (c) => c.correctionTurns >= 2,
    priority: 2,
    text: (c) =>
      `The opening prompt was short and unspecific, and ${c.correctionTurns} corrections ` +
      'followed. Concrete file paths, an example, or acceptance criteria up front usually ' +
      'replace several correction rounds.',
  },
  {
    id: 'state-expected-outcome',
    requires: ['correction-reprompt'],
    when: (c) => c.correctionTurns >= 2 && c.firstPromptRating !== 'vague',
    priority: 3,
    text: (c) =>
      `${c.correctionTurns} follow-ups read as corrections. Repeated corrections usually mean ` +
      'the expected outcome lived only in your head — stating the end state, the constraints, ' +
      "and what 'done' looks like in the first prompt tends to remove them.",
  },
  {
    id: 'capture-environment-context',
    requires: ['tool-error-streak'],
    priority: 4,
    text: (c) =>
      `Tools failed ${c.maxErrorStreak} times in a row at the worst point — often a missing ` +
      'environment assumption (setup steps, credentials, build quirks). Capturing it in ' +
      'CLAUDE.md gives every future session that knowledge for free.',
  },
  {
    id: 'plan-before-large-change',
    requires: ['rework-churn'],
    priority: 5,
    text: (c) =>
      `About ${c.churnRatioPct}% of the code this session added was removed again before it ` +
      'ended. For changes this size, ' +
      (c.planModeUsed
        ? 'a tighter plan up front tends to reduce rework.'
        : 'plan mode (or asking for a plan first) tends to reduce rework.'),
  },
  {
    id: 'split-multi-goal-session',
    requires: ['oversized-first-prompt'],
    priority: 6,
    text: () =>
      'The opening prompt bundles several goals. One goal per session keeps the context ' +
      'focused and makes runs comparable afterwards.',
  },
  {
    id: 'split-long-session',
    requires: ['context-compaction'],
    when: (c) => c.compactions >= COMPACTION_FRICTION_MIN,
    priority: 7,
    text: (c) =>
      `Context was compacted ${c.compactions} times — the session outgrew its window ` +
      'repeatedly. Splitting the work into smaller sessions keeps early decisions in context.',
  },
  {
    id: 'front-load-direction',
    requires: ['user-interruption'],
    when: (c) => c.interruptions >= 2,
    priority: 8,
    text: (c) =>
      `You stopped the agent ${c.interruptions} times mid-run. When interruptions repeat, the ` +
      'missing direction usually belongs in the prompt (or CLAUDE.md) rather than in ' +
      'mid-flight steering.',
  },
  {
    id: 'review-subagent-fanout',
    requires: ['subagent-heavy'],
    when: (c) => c.correctionTurns >= 1 || c.churnRatioPct >= CHURN_RATIO_MIN * 100,
    priority: 9,
    text: () =>
      "Most of this session's spend went to sub-agents, and rework or corrections followed — " +
      'worth checking whether the fan-out produced what you actually needed before scaling ' +
      'it further.',
  },
];

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Session-level gross code churn: lines added vs. removed again, code files
 * only (doc edits are usually prose work, not thrash). This is proposal 08's
 * "Stage 1 coarse ratio" — when `analysis/rework.ts` lands it absorbs this
 * helper and the retrospective delegates to it (stated in both proposals so
 * neither duplicates the other).
 */
export function sessionCodeChurn(turns: readonly SessionTurn[]): {
  added: number;
  removed: number;
  ratioPct: number;
} {
  let added = 0;
  let removed = 0;
  for (const turn of turns) {
    added += turn.linesOfCode;
    removed += turn.linesOfCodeRemoved;
  }
  return { added, removed, ratioPct: Math.round((removed / Math.max(1, added)) * 100) };
}

/**
 * Build the retrospective for one session. Pure: no I/O, no logging. `nowMs`
 * is injectable so tests are deterministic; it only gates the abandonment
 * grace ({@link RECENT_ACTIVITY_GRACE_MS}).
 */
export function buildSessionRetrospective(
  detail: SessionDetail,
  signals?: RetrospectiveSignals,
  nowMs: number = Date.now(),
): SessionRetrospective {
  const turns = detail.turns;
  const findings: RetrospectiveFinding[] = [];

  // Genuine prompts vs. interruption markers and slash-command bookkeeping
  // (both of which the mapper also turns into turns — see INTERRUPTION_PREFIX
  // and isCommandText).
  const prompts: { turnIndex: number; text: string }[] = [];
  const interruptionTurnIndices: number[] = [];
  const commandTurnIndices: number[] = [];
  for (let i = 0; i < turns.length; i++) {
    const text = turns[i].userRequest;
    if (text === undefined) {
      continue;
    }
    if (isInterruptionText(text)) {
      interruptionTurnIndices.push(i);
    } else if (isCommandText(text)) {
      commandTurnIndices.push(i);
    } else {
      prompts.push({ turnIndex: i, text });
    }
  }

  // ── Corrections ──
  const correctionTurnIndices = detectCorrections(turns, prompts, findings);

  // ── Repeated prompts ──
  const repeatedPromptTurns = detectRepeatedPrompts(prompts, findings);

  // ── Interruptions ── the extractor's record-level count is authoritative
  // when present (some Claude Code versions stamp the marker record `isMeta`,
  // hiding it from the turn grouping); the turn-derived count is the fallback.
  const interruptions = signals?.interruptionCount ?? interruptionTurnIndices.length;
  if (interruptions > 0) {
    findings.push({
      id: 'user-interruption',
      severity: 'friction',
      description:
        interruptions === 1
          ? 'You interrupted the agent once mid-run.'
          : `You interrupted the agent ${interruptions} times mid-run.`,
      ...(interruptionTurnIndices.length > 0 ? { turnIndex: interruptionTurnIndices[0] } : {}),
      value: interruptions,
      contentDerived: true,
    });
  }

  // ── Tool-error streaks ──
  const streaks = detectErrorStreaks(turns, findings);

  // ── Rework churn ──
  const churn = sessionCodeChurn(turns);
  const churnFired = churn.added >= CHURN_MIN_LINES_ADDED && churn.removed / Math.max(1, churn.added) >= CHURN_RATIO_MIN;
  if (churnFired) {
    findings.push({
      id: 'rework-churn',
      severity: 'friction',
      description: `${churn.ratioPct}% of the code lines this session added were removed again before it ended.`,
      value: churn.ratioPct,
      contentDerived: false,
    });
  }

  // ── Long-tail turns ──
  const longTailTurnIndices = detectLongTailTurns(turns, findings);

  // ── Context compaction ──
  const compactions = signals?.compactionCount ?? 0;
  if (compactions > 0) {
    findings.push({
      id: 'context-compaction',
      severity: compactions >= COMPACTION_FRICTION_MIN ? 'friction' : 'info',
      description:
        compactions === 1
          ? 'The context window was compacted once — a long run, but an expected one.'
          : `The context window was compacted ${compactions} times — the session repeatedly outgrew it.`,
      value: compactions,
      contentDerived: false,
    });
  }

  // ── Sub-agent-heavy spend ──
  detectSubagentHeavy(detail, findings);

  // ── Plan mode skipped ── advice fodder only; many experts skip plan mode
  // successfully, so this can never be friction. Unknowable without signals.
  const wroteLines = turns.reduce((sum, t) => sum + t.linesOfCode, 0);
  const writingTurns = turns.filter((t) => t.linesOfCode + t.linesOfDoc > 0).length;
  if (
    signals !== undefined &&
    !signals.planModeUsed &&
    wroteLines >= PLAN_ADVICE_MIN_LINES &&
    writingTurns >= PLAN_ADVICE_MIN_TURNS
  ) {
    findings.push({
      id: 'plan-mode-skipped',
      severity: 'info',
      description: `The session wrote ${wroteLines} code lines across ${writingTurns} turns without plan mode.`,
      value: wroteLines,
      contentDerived: false,
    });
  }

  // ── Opening prompt ──
  const firstPrompt = prompts.length > 0 ? assessPrompt(prompts[0].text) : undefined;
  if (firstPrompt !== undefined) {
    if (firstPrompt.rating === 'vague') {
      // Vagueness is only friction when CONFIRMED BY CONSEQUENCE: a short
      // prompt that worked fine was simply an adequate short prompt.
      const confirmed = correctionTurnIndices.length >= 2;
      findings.push({
        id: 'vague-first-prompt',
        severity: confirmed ? 'friction' : 'info',
        description: confirmed
          ? 'The opening prompt was short and unspecific, and repeated corrections followed.'
          : 'The opening prompt was short and unspecific — fine for a small ask, worth expanding for a bigger one.',
        turnIndex: prompts[0].turnIndex,
        contentDerived: true,
      });
    } else if (firstPrompt.rating === 'oversized') {
      findings.push({
        id: 'oversized-first-prompt',
        severity: 'info',
        description: 'The opening prompt is very large and likely bundles several goals.',
        turnIndex: prompts[0].turnIndex,
        value: firstPrompt.chars,
        contentDerived: true,
      });
    }
  }

  // ── Abandoned ending ──
  const abandoned = detectAbandonedEnding(
    detail,
    signals,
    interruptionTurnIndices,
    commandTurnIndices,
    nowMs,
    findings,
  );

  // ── Verdict ──
  const { verdict, verdictReasons } = decideVerdict({
    abandoned,
    correctionCount: correctionTurnIndices.length,
    interruptions,
    churnFired,
    maxErrorStreak: streaks.maxStreak,
    streakInLongTailTurn: streaks.turnIndices.some((i) => longTailTurnIndices.includes(i)),
    repeatedPromptTurns,
    compactions,
    vagueConfirmed: firstPrompt?.rating === 'vague' && correctionTurnIndices.length >= 2,
  });

  // ── Outcome ──
  const outcome = decideOutcome(verdict, turns, prompts, correctionTurnIndices);

  // ── Counts projection + tips ──
  const counts: RetrospectiveCounts = {
    verdict,
    outcome,
    correctionTurns: correctionTurnIndices.length,
    repeatedPromptTurns,
    interruptions,
    errorStreaks: streaks.count,
    maxErrorStreak: streaks.maxStreak,
    longTailTurns: longTailTurnIndices.length,
    compactions,
    churnRatioPct: churn.added >= CHURN_MIN_LINES_ADDED ? churn.ratioPct : 0,
    planModeUsed: signals?.planModeUsed ?? false,
    ...(firstPrompt !== undefined ? { firstPromptRating: firstPrompt.rating } : {}),
    tipCount: 0,
  };
  const tips = buildTips(findings, counts);
  counts.tipCount = tips.length;

  sortFindings(findings);

  const title = detail.summary.title;
  const derived = detail.summary.titleDerived === true;
  const goalSource: GoalSource = title === undefined ? 'none' : derived ? 'first-prompt' : 'ai-title';

  return {
    sessionId: detail.summary.sessionId,
    ...(title !== undefined ? { goal: title } : {}),
    goalSource,
    goalConfidence: goalConfidence(goalSource, firstPrompt),
    verdict,
    verdictReasons,
    outcome,
    findings,
    ...(firstPrompt !== undefined ? { firstPrompt } : {}),
    tips,
    counts,
    contentDerived: true,
  };
}

// ── Detectors ───────────────────────────────────────────────────────────────

/** One finding per correcting follow-up; returns the flagged turn indices. */
function detectCorrections(
  turns: readonly SessionTurn[],
  prompts: readonly { turnIndex: number; text: string }[],
  findings: RetrospectiveFinding[],
): number[] {
  const flagged: number[] = [];
  for (let p = 1; p < prompts.length; p++) {
    const { turnIndex, text } = prompts[p];
    const wroteBefore = turns.slice(0, turnIndex).some((t) => t.linesOfCode + t.linesOfDoc > 0);
    if (!isCorrectionPrompt(text, wroteBefore)) {
      continue;
    }
    flagged.push(turnIndex);
    findings.push({
      id: 'correction-reprompt',
      severity: 'friction',
      description: "The follow-up prompt reads as a correction of the previous turn's work.",
      turnIndex,
      contentDerived: true,
    });
  }
  return flagged;
}

/** Whether a follow-up prompt reads as a correction. Exported for the probe. */
export function isCorrectionPrompt(text: string, wroteBefore: boolean): boolean {
  const trimmed = text.trim().toLowerCase();
  const bare = trimmed.replace(/[.!?\s]+$/u, '');
  if (ACKNOWLEDGMENTS.has(bare)) {
    return false;
  }
  if (trimmed.length <= SHORT_FOLLOW_UP_MAX_CHARS && WHOLE_PROMPT_CORRECTIONS.has(bare)) {
    return true;
  }
  const window = trimmed.slice(0, CORRECTION_SCAN_CHARS);
  if (LEADING_CORRECTION_MARKERS.some((m) => window.startsWith(m))) {
    return true;
  }
  if (wroteBefore && UNDO_MARKERS.some((m) => window.startsWith(m))) {
    return true;
  }
  return ANYWHERE_CORRECTION_MARKERS.some((m) => window.includes(m));
}

/** Near-duplicate re-asks by token-set Jaccard; returns how many turns flagged. */
function detectRepeatedPrompts(
  prompts: readonly { turnIndex: number; text: string }[],
  findings: RetrospectiveFinding[],
): number {
  const compared = prompts.slice(0, MAX_COMPARED_TURNS);
  const tokenSets = compared.map((p) => tokenSet(p.text));
  let flaggedCount = 0;
  for (let j = 1; j < compared.length; j++) {
    if (tokenSets[j].size < REPEAT_MIN_TOKENS) {
      continue;
    }
    for (let i = 0; i < j; i++) {
      if (tokenSets[i].size < REPEAT_MIN_TOKENS) {
        continue;
      }
      if (jaccard(tokenSets[i], tokenSets[j]) >= REPEAT_SIMILARITY_MIN) {
        flaggedCount++;
        findings.push({
          id: 'repeated-prompt',
          severity: 'friction',
          description: 'This prompt re-asks essentially the same thing as an earlier one.',
          turnIndex: compared[j].turnIndex,
          contentDerived: true,
        });
        break;
      }
    }
  }
  return flaggedCount;
}

function tokenSet(text: string): Set<string> {
  const tokens = text
    .slice(0, MAX_PROMPT_SCAN_CHARS)
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((t) => t.length >= 3);
  return new Set(tokens);
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) {
      intersection++;
    }
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Maximal runs of consecutive FAILED tool events, scoped within a turn (a
 * streak "spanning" a user prompt was interrupted by a human — a different
 * situation). Non-tool events between two tool events do not break a run: the
 * mapper interleaves a `chat` event before each assistant record's tools, so
 * literal adjacency would never exceed one. Distinct from the deviation
 * engine's >50% failure RATE check: a long turn can pass the rate check while
 * containing exactly the stuck-in-a-loop streak this looks for.
 */
function detectErrorStreaks(
  turns: readonly SessionTurn[],
  findings: RetrospectiveFinding[],
): { count: number; maxStreak: number; turnIndices: number[] } {
  let count = 0;
  let maxStreak = 0;
  const turnIndices: number[] = [];
  for (let i = 0; i < turns.length; i++) {
    let run = 0;
    const flush = (): void => {
      if (run >= ERROR_STREAK_MIN) {
        count++;
        maxStreak = Math.max(maxStreak, run);
        turnIndices.push(i);
        findings.push({
          id: 'tool-error-streak',
          severity: 'friction',
          description: `${run} tool calls failed in a row.`,
          turnIndex: i,
          value: run,
          contentDerived: false,
        });
      }
      run = 0;
    };
    for (const event of turns[i].events) {
      if (event.operation !== 'execute_tool') {
        continue;
      }
      if (event.success) {
        flush();
      } else {
        run++;
      }
    }
    flush();
  }
  return { count, maxStreak, turnIndices };
}

/**
 * Turns with at least {@link LONG_TURN_MS} of ACTIVE time. The Claude mapper
 * leaves `SessionTurn.durationMs` at 0, so activity is summed from the event
 * durations — with each event clamped to {@link LONG_EVENT_CLAMP_MS}, because
 * a chat event's duration is the gap since the previous record and an
 * overnight pause is idle time, not a 700-minute turn. `info` only: a long
 * autonomous turn is often the GOOD case — context for the reader, not
 * friction.
 */
function detectLongTailTurns(
  turns: readonly SessionTurn[],
  findings: RetrospectiveFinding[],
): number[] {
  const flagged: number[] = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn.events.length === 0) {
      continue;
    }
    let activeMs = 0;
    for (const event of turn.events) {
      activeMs += Math.min(Math.max(0, event.durationMs), LONG_EVENT_CLAMP_MS);
    }
    const effectiveMs = Math.max(turn.durationMs, activeMs);
    if (effectiveMs >= LONG_TURN_MS) {
      flagged.push(i);
      findings.push({
        id: 'long-tail-turn',
        severity: 'info',
        description: `One turn worked for about ${Math.round(effectiveMs / 60_000)} minutes — where the session's time went.`,
        turnIndex: i,
        value: effectiveMs,
        contentDerived: false,
      });
    }
  }
  return flagged;
}

/** Sub-agents dominating spend. Never friction — fan-out is a strategy. */
function detectSubagentHeavy(detail: SessionDetail, findings: RetrospectiveFinding[]): void {
  let subTokens = 0;
  let subCalls = 0;
  for (const usage of detail.agentUsage) {
    if (usage.kind === 'subagent') {
      subTokens += usage.inputTokens + usage.outputTokens + usage.cachedTokens;
      subCalls += usage.llmCalls;
    }
  }
  const total = detail.treeStats.totalTokens;
  const share = subTokens / Math.max(1, total);
  const byShare = total >= SUBAGENT_MIN_TOTAL_TOKENS && share >= SUBAGENT_TOKEN_SHARE_MIN;
  if (byShare || subCalls >= SUBAGENT_CALLS_MIN) {
    findings.push({
      id: 'subagent-heavy',
      severity: 'info',
      description: `Sub-agents carried ${Math.round(share * 100)}% of this session's token spend across ${subCalls} model calls.`,
      value: Math.round(share * 100),
      contentDerived: false,
    });
  }
}

/**
 * Whether the session trailed off unfinished. Deliberately does NOT fire just
 * because the last assistant response went unacknowledged — that is the normal
 * happy ending. Recent activity is granted a grace period so a session that is
 * simply still running is not judged abandoned mid-flight.
 */
function detectAbandonedEnding(
  detail: SessionDetail,
  signals: RetrospectiveSignals | undefined,
  interruptionTurnIndices: readonly number[],
  commandTurnIndices: readonly number[],
  nowMs: number,
  findings: RetrospectiveFinding[],
): boolean {
  if (nowMs - detail.summary.endedAtMs < RECENT_ACTIVITY_GRACE_MS) {
    return false;
  }
  const turns = detail.turns;
  const last = turns.length > 0 ? turns[turns.length - 1] : undefined;
  const lastIndex = turns.length - 1;

  // A session that ends with slash-command bookkeeping (`/clear`, …) ended
  // normally: the command IS how sessions close. Never abandonment evidence.
  if (commandTurnIndices.includes(lastIndex)) {
    return false;
  }

  const unansweredGenuinePrompt =
    last?.userRequest !== undefined &&
    last.llmCalls === 0 &&
    !isCommandText(last.userRequest) &&
    !isInterruptionText(last.userRequest);

  let cause: string | undefined;
  if (signals?.endedWithInterruption === true || interruptionTurnIndices.includes(lastIndex)) {
    cause = 'The session ended on an interruption — the agent was stopped and never resumed.';
  } else if (signals?.lastEvent === 'user-request' || unansweredGenuinePrompt) {
    cause = 'The final prompt was never answered.';
  } else if (last !== undefined && last.events.length > 0) {
    const lastEvent = last.events[last.events.length - 1];
    if (lastEvent.operation === 'chat' && !lastEvent.success) {
      cause = 'The session ended on a failed model call.';
    }
  }
  if (cause === undefined) {
    return false;
  }
  findings.push({
    id: 'abandoned-ending',
    severity: 'blocker',
    description: cause,
    ...(last !== undefined ? { turnIndex: lastIndex } : {}),
    contentDerived: true,
  });
  return true;
}

// ── Verdict / outcome / tips ────────────────────────────────────────────────

interface VerdictInputs {
  abandoned: boolean;
  correctionCount: number;
  interruptions: number;
  churnFired: boolean;
  maxErrorStreak: number;
  streakInLongTailTurn: boolean;
  repeatedPromptTurns: number;
  compactions: number;
  vagueConfirmed: boolean;
}

/**
 * Explicit, explainable rules — no weighted score. Each rule cites the finding
 * ids that decided it so the UI can say WHY, not just WHAT.
 */
function decideVerdict(v: VerdictInputs): {
  verdict: SessionVerdict;
  verdictReasons: RetrospectiveSignalId[];
} {
  if (v.abandoned) {
    return { verdict: 'abandoned', verdictReasons: ['abandoned-ending'] };
  }

  const struggled: RetrospectiveSignalId[] = [];
  if (v.correctionCount >= 3) {
    struggled.push('correction-reprompt');
  }
  if (v.interruptions >= 3) {
    struggled.push('user-interruption');
  }
  if (v.correctionCount + v.interruptions >= 4 && struggled.length === 0) {
    struggled.push('correction-reprompt', 'user-interruption');
  }
  if (v.churnFired && v.correctionCount >= 1) {
    struggled.push('rework-churn');
  }
  if (v.maxErrorStreak >= ERROR_STREAK_STRUGGLE) {
    struggled.push('tool-error-streak');
  }
  if (v.streakInLongTailTurn) {
    // Ten minutes of consecutive failures is decisive even below the
    // standalone streak threshold.
    if (!struggled.includes('tool-error-streak')) {
      struggled.push('tool-error-streak');
    }
    if (!struggled.includes('long-tail-turn')) {
      struggled.push('long-tail-turn');
    }
  }
  if (struggled.length > 0) {
    return { verdict: 'struggled', verdictReasons: struggled };
  }

  const bumpy: RetrospectiveSignalId[] = [];
  if (v.correctionCount > 0) {
    bumpy.push('correction-reprompt');
  }
  if (v.interruptions > 0) {
    bumpy.push('user-interruption');
  }
  if (v.maxErrorStreak >= ERROR_STREAK_MIN) {
    bumpy.push('tool-error-streak');
  }
  if (v.churnFired) {
    bumpy.push('rework-churn');
  }
  if (v.repeatedPromptTurns > 0) {
    bumpy.push('repeated-prompt');
  }
  if (v.compactions >= COMPACTION_FRICTION_MIN) {
    bumpy.push('context-compaction');
  }
  if (v.vagueConfirmed) {
    bumpy.push('vague-first-prompt');
  }
  if (bumpy.length > 0) {
    return { verdict: 'bumpy', verdictReasons: bumpy };
  }
  return { verdict: 'smooth', verdictReasons: [] };
}

/**
 * Kept deliberately modest: heuristics observe friction, not correctness, so
 * `unclear` is not a defect — it is the honest answer, and the
 * {@link SessionRetrospective.llmVerdict} slot exists precisely to upgrade it.
 */
function decideOutcome(
  verdict: SessionVerdict,
  turns: readonly SessionTurn[],
  prompts: readonly { turnIndex: number; text: string }[],
  correctionTurnIndices: readonly number[],
): SessionOutcome {
  if (verdict === 'abandoned') {
    return 'likely-unfulfilled';
  }
  const last = turns.length > 0 ? turns[turns.length - 1] : undefined;
  const answered = last?.finalResponse !== undefined;
  const tailPromptIndices = prompts.slice(-2).map((p) => p.turnIndex);
  const tailCorrected = correctionTurnIndices.some((i) => tailPromptIndices.includes(i));
  if ((verdict === 'smooth' || verdict === 'bumpy') && answered && !tailCorrected) {
    return 'likely-fulfilled';
  }
  if (verdict === 'struggled' && answered && !tailCorrected) {
    return 'partially';
  }
  return 'unclear';
}

/** Evaluate the advice table; at most {@link MAX_TIPS}, priority order. */
function buildTips(
  findings: readonly RetrospectiveFinding[],
  counts: RetrospectiveCounts,
): RetrospectiveTip[] {
  const present = new Set(findings.map((f) => f.id));
  const tips: RetrospectiveTip[] = [];
  const rules = [...ADVICE_RULES].sort((a, b) => a.priority - b.priority);
  for (const rule of rules) {
    if (tips.length >= MAX_TIPS) {
      break;
    }
    if (!rule.requires.every((id) => present.has(id))) {
      continue;
    }
    if (rule.when !== undefined && !rule.when(counts)) {
      continue;
    }
    tips.push({ id: rule.id, text: rule.text(counts), evidence: [...rule.requires] });
  }
  return tips;
}

// ── Small helpers ───────────────────────────────────────────────────────────

/** Assess the opening prompt's shape. Exported for the probe and tests. */
export function assessPrompt(text: string): PromptAssessment {
  const scanned = text.slice(0, MAX_PROMPT_SCAN_CHARS);
  const lower = scanned.toLowerCase();
  const markers: PromptMarker[] = [];

  if (FILE_PATH_RE.test(scanned) || FILE_EXT_RE.test(lower)) {
    markers.push('file-path');
  }
  if (scanned.includes('`')) {
    markers.push('code-span');
  }
  const firstWord = lower.trimStart().split(/\s+/u, 1)[0] ?? '';
  if (IMPERATIVE_VERBS.has(firstWord)) {
    markers.push('imperative-verb');
  }
  if (ACCEPTANCE_MARKERS.some((m) => lower.includes(m))) {
    markers.push('acceptance-criteria');
  }
  if (CONSTRAINT_MARKERS.some((m) => lower.includes(m))) {
    markers.push('constraints');
  }
  const listLines = scanned.split('\n').filter((line) => LIST_LINE_RE.test(line)).length;
  if (listLines >= 2) {
    markers.push('list-structure');
  }

  const chars = text.length;
  const words = text.trim().length === 0 ? 0 : text.trim().split(/\s+/u).length;
  let rating: PromptRating;
  if (chars > OVERSIZED_PROMPT_CHARS || listLines >= OVERSIZED_GOAL_LINES) {
    rating = 'oversized';
  } else if (chars < VAGUE_PROMPT_MAX_CHARS && markers.length <= 1) {
    rating = 'vague';
  } else if (markers.length >= SPECIFIC_MARKERS_MIN) {
    rating = 'specific';
  } else {
    rating = 'adequate';
  }
  return { chars, words, markers, rating };
}

function goalConfidence(source: GoalSource, firstPrompt: PromptAssessment | undefined): GoalConfidence {
  if (source === 'none') {
    return 'low';
  }
  if (source === 'ai-title' || source === 'summary') {
    return firstPrompt?.rating === 'specific' ? 'high' : 'medium';
  }
  // Derived from the first prompt: only as trustworthy as that prompt.
  if (firstPrompt === undefined || firstPrompt.rating === 'vague' || firstPrompt.rating === 'oversized') {
    return 'low';
  }
  return 'medium';
}

const SEVERITY_RANK = { blocker: 0, friction: 1, info: 2 } as const;

/** Blockers first, then friction, then info; by turn within a tier. */
function sortFindings(findings: RetrospectiveFinding[]): void {
  findings.sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) {
      return bySeverity;
    }
    return (a.turnIndex ?? Number.MAX_SAFE_INTEGER) - (b.turnIndex ?? Number.MAX_SAFE_INTEGER);
  });
}
