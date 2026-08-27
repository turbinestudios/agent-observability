import type { SessionSummary } from '../telemetry/models';
import type { Result } from '../telemetry/telemetryService';

/**
 * Pure render planning for the `@obs` chat participant.
 *
 * This module is deliberately free of any `vscode` import so it can be unit
 * tested headlessly (see {@link ../../vitest.config}). The participant
 * ({@link ./observabilityChat}) calls {@link planChatResponse} and translates
 * the returned plan into `stream.markdown` / `stream.button` calls.
 *
 * The participant lists recent sessions as buttons that open the LOCAL
 * session-detail webview, most-recently-active first. Sessions whose repository
 * couldn't be resolved (the `unknown` sentinel) are excluded, and buttons are
 * labelled with the session title.
 */

/** How many sessions to surface as buttons in one response. */
export const SESSION_BUTTON_LIMIT = 5;

/** Repository sentinel for sessions whose repository couldn't be resolved. */
const UNKNOWN_REPOSITORY = 'unknown';

/** A button to render: opens the LOCAL detail view for one session. */
export interface ChatButton {
  /** The owning source id, passed first to `openSession` so it routes correctly. */
  sourceId: string;
  /** The session key passed to the `openSession` command. */
  sessionId: string;
  /** Human-readable button text (the session title). */
  title: string;
}

/** What the participant should render for a request. */
export interface ChatPlan {
  /** Leading markdown line (status, header, or "no match"). */
  markdown: string;
  /** Buttons to render under the markdown (possibly empty). */
  buttons: ChatButton[];
}

/**
 * Decide what to render for a `@obs` request, given the session lookup result
 * and the user's free-text query. Only sessions with a known repository are
 * considered, ordered most-recently-active first.
 *
 * - lookup failed → an explanatory line, no buttons.
 * - no sessions at all → an empty-state line.
 * - no known-repository sessions → an empty-state line.
 * - empty query → buttons for the most recent sessions (capped).
 * - query with matches → buttons for the matches (capped).
 * - query with no match → a hint line, no buttons.
 */
export function planChatResponse(result: Result<SessionSummary[]>, query: string): ChatPlan {
  if (!result.ok) {
    return { markdown: `Couldn't read local sessions — ${result.message}`, buttons: [] };
  }
  if (result.value.length === 0) {
    return { markdown: 'No local agent sessions recorded yet.', buttons: [] };
  }

  // Skip sessions whose repository couldn't be resolved, then order by recency.
  const known = result.value.filter((s) => s.repository !== UNKNOWN_REPOSITORY);
  if (known.length === 0) {
    return { markdown: 'No sessions with a known repository recorded yet.', buttons: [] };
  }
  const recent = [...known].sort(byRecentActivity);

  const trimmed = query.trim();
  const matches = matchSessions(recent, trimmed).slice(0, SESSION_BUTTON_LIMIT);
  if (matches.length === 0) {
    return {
      markdown: `No session matches \`${trimmed}\`. Send \`@obs\` with no text to list recent sessions.`,
      buttons: [],
    };
  }

  const noun = matches.length === 1 ? 'session' : 'sessions';
  const header =
    trimmed.length === 0
      ? `Most recent ${noun} — open the local detail view:`
      : `Matching ${noun} — open the local detail view:`;
  return { markdown: `${header}\n`, buttons: matches.map(toButton) };
}

/**
 * Filter sessions by a free-text query. An empty query matches everything.
 * Otherwise matches a session whose LOCAL-ONLY title (or id) contains the query,
 * case-insensitively.
 */
export function matchSessions(sessions: SessionSummary[], query: string): SessionSummary[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) {
    return sessions;
  }
  return sessions.filter(
    (s) =>
      (s.title !== undefined && s.title.toLowerCase().includes(q)) ||
      s.sessionId.toLowerCase().includes(q),
  );
}

/**
 * Order sessions most-recently-active first: latest {@link SessionSummary.endedAtMs}
 * (last span), tie-broken by latest start.
 */
function byRecentActivity(a: SessionSummary, b: SessionSummary): number {
  return b.endedAtMs - a.endedAtMs || b.startedAtMs - a.startedAtMs;
}

/** Map a session to its button descriptor (source id defaults to Copilot when absent). */
function toButton(session: SessionSummary): ChatButton {
  return { sourceId: session.source ?? 'copilot', sessionId: session.sessionId, title: buttonLabel(session) };
}

/** Button text: the LOCAL-ONLY title (falls back to a short id defensively). */
export function buttonLabel(session: SessionSummary): string {
  const base =
    session.title !== undefined ? truncate(session.title, 48) : shortId(session.sessionId);
  return `Open: ${base}`;
}

/** Short, human-friendly session id (first UUID segment, else truncated). */
function shortId(sessionId: string): string {
  const dash = sessionId.indexOf('-');
  if (dash > 0) {
    return sessionId.slice(0, dash);
  }
  return sessionId.length > 12 ? `${sessionId.slice(0, 12)}…` : sessionId;
}

/** Collapse whitespace and truncate to `max` chars with an ellipsis. */
function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}
