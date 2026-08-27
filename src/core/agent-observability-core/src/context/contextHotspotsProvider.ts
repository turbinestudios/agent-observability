/**
 * Local context-hotspots provider — LOCAL-ONLY.
 *
 * Builds the file→sessions {@link ContextHotspot} index from the Copilot
 * telemetry service by reusing the SAME extractor the cloud sync path uses, but
 * retaining the (local-only) session ids that aggregation strips before upload.
 * This is the on-machine bridge from a Context Hotspot on the dashboard back to
 * the concrete sessions to investigate.
 *
 * Headless: it takes a workspace-cwd getter and a small telemetry surface, so it
 * has no `vscode` import and runs under vitest with a fake telemetry object. The
 * result is cached until {@link refresh} is called, because building it reads the
 * (potentially large) system-prompt blobs for every recent session.
 */

import type { Result } from '../telemetry/telemetryService';
import type { SessionSummary } from '../telemetry/models';
import type { DiscoveryEventRow } from '../context/discoveryParser';
import { buildRepoCustomizationIndex } from '../aggregate/customizationFilter';
import {
  extractContextObservations,
  type ContextSignalsProvider,
  type SessionContext,
} from '../aggregate/contextInsightsExtractor';
import { buildContextHotspots, type ContextHotspot } from '../aggregate/contextHotspotsIndex';

/** The bounded set of most-recent sessions scanned for context hotspots. */
export const HOTSPOT_SESSION_LIMIT = 150;

/** The telemetry surface the provider reads (satisfied by `TelemetryService`). */
export interface HotspotTelemetry {
  listSessions(repository?: string, limit?: number): Result<SessionSummary[]>;
  getContextDiscoveryEvents(sessionKey: string): Result<readonly DiscoveryEventRow[]>;
  getContextToolReads(sessionKey: string): Result<ReadonlyArray<{ filePath: string }>>;
  getSystemInstructionsBySpan(sessionKey: string): Result<ReadonlyMap<string, { value: string }>>;
}

/** What the tree view needs from the provider (kept tiny for fakeable tests). */
export interface ContextHotspotsProvider {
  /** Whether the underlying source is enabled. */
  isEnabled(): boolean;
  /** Build (or return cached) hotspots. */
  getHotspots(): Result<ContextHotspot[]>;
  /** Display metadata for a session id, or `undefined` when unknown. */
  describeSession(sessionKey: string): SessionSummary | undefined;
  /** Drop cached state so the next call rebuilds from telemetry. */
  refresh(): void;
}

/**
 * Copilot-backed {@link ContextHotspotsProvider}. Reads recent sessions, extracts
 * their context observations locally, and folds them into the file-keyed index.
 */
export class CopilotContextHotspotsProvider implements ContextHotspotsProvider {
  private cached: Result<ContextHotspot[]> | undefined;
  private sessionsById = new Map<string, SessionSummary>();

  constructor(
    private readonly telemetry: HotspotTelemetry,
    private readonly getWorkspaceCwd: () => string | undefined,
    private readonly isSourceEnabled: () => boolean,
  ) {}

  isEnabled(): boolean {
    return this.isSourceEnabled();
  }

  refresh(): void {
    this.cached = undefined;
    this.sessionsById = new Map();
  }

  getHotspots(): Result<ContextHotspot[]> {
    if (this.cached !== undefined) {
      return this.cached;
    }
    const listed = this.telemetry.listSessions(undefined, HOTSPOT_SESSION_LIMIT);
    if (!listed.ok) {
      this.cached = listed;
      return listed;
    }

    this.sessionsById = new Map(listed.value.map((s) => [s.sessionId, s]));
    const sessions: SessionContext[] = listed.value.map((s) => ({
      sessionKey: s.sessionId,
      repository: s.repository,
      startTimeMs: s.startedAtMs,
      hadError: false,
      hadDeviation: false,
    }));

    const provider: ContextSignalsProvider = (sessionKey) => {
      const discovery = this.telemetry.getContextDiscoveryEvents(sessionKey);
      const toolReads = this.telemetry.getContextToolReads(sessionKey);
      const systemInstr = this.telemetry.getSystemInstructionsBySpan(sessionKey);
      return {
        discoveryEvents: discovery.ok ? discovery.value : [],
        toolReads: toolReads.ok ? toolReads.value.map((r) => ({ filePath: r.filePath })) : [],
        systemInstructions: systemInstr.ok ? [...systemInstr.value.values()].map((v) => v.value) : [],
      };
    };

    const index = buildRepoCustomizationIndex(this.getWorkspaceCwd());
    const observations = extractContextObservations(sessions, provider, this.getWorkspaceCwd(), index);
    const hotspots = buildContextHotspots(observations);
    this.cached = { ok: true, value: hotspots };
    return this.cached;
  }

  describeSession(sessionKey: string): SessionSummary | undefined {
    return this.sessionsById.get(sessionKey);
  }
}
