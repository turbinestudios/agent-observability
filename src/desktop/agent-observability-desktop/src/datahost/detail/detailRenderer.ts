import * as crypto from 'node:crypto';
import {
  renderSessionDetailHtml,
  renderSessionDetailContent,
  renderCombinedSessionDetailHtml,
} from '@agent-observability/core/src/views/sessionDetailHtml';
import type { CombinedSessionSection } from '@agent-observability/core/src/views/sessionDetailHtml';
import { combineSessionDetails } from '@agent-observability/core/src/telemetry/combinedSessionDetail';
import type { SessionDataSource } from '@agent-observability/core/src/sources/sessionSource';
import type { LocalDeviationDetector } from '@agent-observability/core/src/deviation/localDeviations';
import type { WorkflowDeviation } from '@agent-observability/core/src/deviation/models';
import type { AcceptedMissingConfig } from '@agent-observability/core/src/context/contextAnalyzer';
import type { SessionContextAnalysis } from '@agent-observability/core/src/context/models';
import type { CostMode, SessionDetail } from '@agent-observability/core/src/telemetry/models';
import type { CombinedDetailResult } from '../../shared/rpc';
import { detectTurnDeviations } from '../analysis/turnDeviations';
import { chooseCostBasis } from './costBasis';
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

/** One session in a combined view, resolved by the caller like a single render. */
export interface CombinedRequest {
  source: string;
  sessionId: string;
  stamp: number;
  context: DetailContext;
}

interface CacheEntry {
  detail: SessionDetail;
  context: SessionContextAnalysis | undefined;
  /** Per-turn workflow deviations, aligned by index to `detail.turns`. */
  deviations: WorkflowDeviation[][];
  /** The accepted-missing lists the analysis was computed against. */
  acceptedKey: string;
  stamp: number;
}

export class DetailRenderer {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly sources: { get(id: string): SessionDataSource | undefined },
    private readonly deviations: LocalDeviationDetector,
  ) {}

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
      entry.deviations,
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
      entry.deviations,
      entry.context,
      this.costMode(source),
    );
  }

  /**
   * One document for several sessions: merged totals, a token trend in which
   * each session's span is labelled, and a collapsible section per session.
   *
   * Sections are ordered by start time before merging, which is what makes the
   * concatenated per-turn series read as one continuous line rather than
   * jumping backwards between sessions.
   *
   * A session that cannot be read is left out and counted, not fatal: one
   * unreadable transcript should not cost the user the comparison. All of them
   * failing does throw, because there is nothing to show.
   *
   * Nothing is memoized beyond the per-session parses {@link load} already
   * holds — the merge and the markup are string work, and a second cache would
   * duplicate the invalidation that rename, delete and context actions drive.
   */
  renderCombinedDocument(
    requests: readonly CombinedRequest[],
    theme: DetailTheme,
  ): CombinedDetailResult {
    const sections: CombinedSessionSection[] = [];
    const costSources: { costMode: CostMode; label: string; startedAtMs: number }[] = [];
    let skipped = 0;

    for (const request of requests) {
      let entry: CacheEntry;
      try {
        entry = this.load(request.source, request.sessionId, request.stamp, request.context);
      } catch {
        skipped += 1;
        continue;
      }
      const detail = withTitle(entry.detail, request.context.renamedTitle);
      sections.push({ detail, turnDeviations: entry.deviations });
      costSources.push({
        costMode: this.costMode(request.source),
        label: this.sources.get(request.source)?.label ?? request.source,
        startedAtMs: detail.summary.startedAtMs,
      });
    }

    if (sections.length === 0) {
      throw new Error('None of the selected sessions could be loaded.');
    }

    sections.sort((a, b) => a.detail.summary.startedAtMs - b.detail.summary.startedAtMs);
    const combined = combineSessionDetails(sections.map((s) => s.detail));
    const { costMode, note } = chooseCostBasis(costSources);
    const nonce = makeNonce();

    return {
      html: renderCombinedSessionDetailHtml(
        { combined, sections },
        nonce,
        costMode,
        // Host-authored only — never interpolate session content here.
        detailHeadHtml(nonce, theme),
      ),
      costNote: note,
      skipped,
    };
  }

  /** Drop a session's memoized parse, e.g. when its transcript changed. */
  invalidate(source: string, sessionId: string): void {
    this.cache.delete(`${source}:${sessionId}`);
  }

  /**
   * Drop every memoized parse. Needed when a setting changes what the SAME
   * transcript should say — the deviation threshold is one — since the cache is
   * keyed on the transcript's index stamp, which such a change does not move.
   */
  invalidateAll(): void {
    this.cache.clear();
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

    const entry: CacheEntry = {
      detail: result.value,
      context: analysis,
      // Computed with the parse rather than at render time: both shapes of
      // render (full document and body-only refresh) need the same arrays, and
      // detection re-reads the session's interactions.
      deviations: detectTurnDeviations(dataSource, sessionId, result.value, this.deviations),
      acceptedKey,
      stamp,
    };
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

function makeNonce(): string {
  return crypto.randomBytes(16).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 22);
}
