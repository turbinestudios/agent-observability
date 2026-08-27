import * as crypto from 'node:crypto';
import { renderSessionDetailHtml, renderSessionDetailContent } from '@agent-observability/core/src/views/sessionDetailHtml';
import type { SessionDataSource } from '@agent-observability/core/src/sources/sessionSource';
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
 * Parsing a detail is expensive (it reads whole transcripts), so results are
 * memoized until the session's indexed timestamp moves.
 */

export type DetailTheme = 'light' | 'dark';

interface CacheEntry {
  detail: SessionDetail;
  stamp: number;
}

export class DetailRenderer {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly sources: { get(id: string): SessionDataSource | undefined }) {}

  /** The full document, for a first open or a theme change. */
  renderDocument(source: string, sessionId: string, theme: DetailTheme, stamp: number): string {
    const detail = this.load(source, sessionId, stamp);
    const nonce = makeNonce();
    return renderSessionDetailHtml(
      detail,
      noDeviations(detail),
      nonce,
      undefined,
      this.costMode(source),
      // Host-authored only — never interpolate session content here.
      detailHeadHtml(nonce, theme),
    );
  }

  /** Body-only markup, for pushing an update into an already-open document. */
  renderBody(source: string, sessionId: string, stamp: number): string {
    const detail = this.load(source, sessionId, stamp);
    return renderSessionDetailContent(detail, noDeviations(detail), undefined, this.costMode(source));
  }

  /** Drop a session's memoized parse, e.g. when its transcript changed. */
  invalidate(source: string, sessionId: string): void {
    this.cache.delete(`${source}:${sessionId}`);
  }

  private costMode(source: string): CostMode {
    return this.sources.get(source)?.costMode ?? 'aiu';
  }

  private load(source: string, sessionId: string, stamp: number): SessionDetail {
    const key = `${source}:${sessionId}`;
    const cached = this.cache.get(key);
    if (cached !== undefined && cached.stamp === stamp) {
      return cached.detail;
    }
    const dataSource = this.sources.get(source);
    if (dataSource === undefined) {
      throw new Error(`No source registered for "${source}"`);
    }
    const result = dataSource.getSessionDetail(sessionId);
    if (!result.ok) {
      throw new Error(result.message);
    }
    this.cache.set(key, { detail: result.value, stamp });
    return result.value;
  }
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
