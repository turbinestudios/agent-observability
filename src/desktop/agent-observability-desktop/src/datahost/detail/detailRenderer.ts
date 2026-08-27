import * as crypto from 'node:crypto';
import { renderSessionDetailHtml, renderSessionDetailContent } from '@agent-observability/core/src/views/sessionDetailHtml';
import type { SessionDataSource } from '@agent-observability/core/src/sources/sessionSource';
import type { AcceptedMissingConfig } from '@agent-observability/core/src/context/contextAnalyzer';
import type { SessionContextAnalysis } from '@agent-observability/core/src/context/models';
import type { CostMode, SessionDetail } from '@agent-observability/core/src/telemetry/models';
import { detailHeadHtml } from './theme';

/**
 * Renders a session's detail document using the same renderer the extension
 * uses — the app draws the turn-by-turn view from shared code rather than a
 * reimplementation, so the two stay identical for free.
 *
 * Two shapes are produced, matching how the document updates itself:
 *  - the FULL document on first open, and
 *  - the BODY only for a refresh, which the document's own controller swaps in
 *    place, preserving scroll position, the active tab, and open sections.
 *
 * Both the parse and the context analysis are expensive — the Claude path reads
 * every subagent transcript and walks the `.claude` hierarchy on disk — so a
 * session's work is memoized until its indexed timestamp moves.
 */

export type DetailTheme = 'light' | 'dark';

/** What the host must supply per render, resolved fresh each time. */
export interface DetailContext {
  /** Files and sources the user has accepted as legitimately missing. */
  acceptedMissing: AcceptedMissingConfig;
  /** The user's name for this session, when they have set one. */
  renamedTitle?: string;
}

interface CacheEntry {
  detail: SessionDetail;
  context: SessionContextAnalysis | undefined;
  /** The accepted-missing lists the analysis was computed against. */
  acceptedKey: string;
  stamp: number;
}

export class DetailRenderer {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly sources: { get(id: string): SessionDataSource | undefined }) {}

  /** The full document, for a first open or a theme change. */
  renderDocument(
    source: string,
    sessionId: string,
    theme: DetailTheme,
    stamp: number,
    context: DetailContext,
  ): string {
    const entry = this.load(source, sessionId, stamp, context);
    const nonce = makeNonce();
    return renderSessionDetailHtml(
      withTitle(entry.detail, context.renamedTitle),
      noDeviations(entry.detail),
      nonce,
      entry.context,
      this.costMode(source),
      // Host-authored only — never interpolate session content here.
      detailHeadHtml(nonce, theme),
    );
  }

  /** Body-only markup, for pushing an update into an already-open document. */
  renderBody(source: string, sessionId: string, stamp: number, context: DetailContext): string {
    const entry = this.load(source, sessionId, stamp, context);
    return renderSessionDetailContent(
      withTitle(entry.detail, context.renamedTitle),
      noDeviations(entry.detail),
      entry.context,
      this.costMode(source),
    );
  }

  /** Drop a session's memoized parse, e.g. when its transcript changed. */
  invalidate(source: string, sessionId: string): void {
    this.cache.delete(`${source}:${sessionId}`);
  }

  private costMode(source: string): CostMode {
    return this.sources.get(source)?.costMode ?? 'aiu';
  }

  private load(
    source: string,
    sessionId: string,
    stamp: number,
    context: DetailContext,
  ): CacheEntry {
    const key = `${source}:${sessionId}`;
    const acceptedKey = acceptedFingerprint(context.acceptedMissing);
    const cached = this.cache.get(key);
    // Accepting a missing file changes what the analysis should report, so the
    // accepted lists are part of the cache key rather than just the timestamp.
    if (cached !== undefined && cached.stamp === stamp && cached.acceptedKey === acceptedKey) {
      return cached;
    }

    const dataSource = this.sources.get(source);
    if (dataSource === undefined) {
      throw new Error(`No source registered for "${source}"`);
    }
    const result = dataSource.getSessionDetail(sessionId);
    if (!result.ok) {
      throw new Error(result.message);
    }

    // Optional per source, and allowed to fail: a session is still worth
    // showing without its context breakdown, so a failure here hides the tab
    // rather than the whole document.
    let analysis: SessionContextAnalysis | undefined;
    try {
      analysis = dataSource.getContextAnalysis?.(sessionId, context.acceptedMissing);
    } catch {
      analysis = undefined;
    }

    const entry: CacheEntry = { detail: result.value, context: analysis, acceptedKey, stamp };
    this.cache.set(key, entry);
    return entry;
  }
}

/** Apply the user's chosen name without mutating the cached parse. */
function withTitle(detail: SessionDetail, renamedTitle: string | undefined): SessionDetail {
  if (renamedTitle === undefined) {
    return detail;
  }
  return {
    ...detail,
    summary: { ...detail.summary, title: renamedTitle, titleDerived: false },
  };
}

function acceptedFingerprint(accepted: AcceptedMissingConfig): string {
  return `${[...accepted.files].sort().join('|')}##${[...accepted.sources].sort().join('|')}`;
}

/**
 * Workflow deviation markers are a VS Code-side feature driven by configured
 * workflows; the desktop app has no workflow editor yet, so every turn renders
 * without markers. The renderer indexes this per turn, so it must be the right
 * length rather than empty.
 */
function noDeviations(detail: SessionDetail): readonly (readonly [])[] {
  return detail.turns.map(() => []);
}

function makeNonce(): string {
  return crypto.randomBytes(16).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 22);
}
