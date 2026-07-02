import type { Configuration } from '../config/configuration';
import { LocalDeviationDetector } from '../deviation/localDeviations';
import { groupInteractionsByTurn } from '../deviation/turnGrouping';
import {
  LocatedDivergence,
  divergenceKey,
  selectNewDivergences,
  settledTurnIndices,
} from '../deviation/divergenceNotices';
import type { SessionDataSource, SourceRegistry } from '../sources/sessionSource';

/** How long after a turn ends before a divergence in it is reportable (anti-mid-task). */
const SETTLE_MS = 30_000;
/** How many recent sessions to scan per SOURCE per pass (each source is a short rolling window). */
const SCAN_SESSION_LIMIT = 50;
/** Cap individual toasts per scan; the remainder collapses into one summary toast. */
const MAX_NOTICES_PER_SCAN = 4;

/**
 * Shows one workflow-divergence warning to the user. `action`, when given, is an
 * actionable button label; the returned promise resolves to the chosen label (or
 * `undefined` when dismissed). Injected so the scanner carries no `vscode` import
 * and stays headless-testable — the production adapter wraps
 * `vscode.window.showWarningMessage`.
 */
export type ShowDivergenceWarning = (
  message: string,
  action?: string,
) => PromiseLike<string | undefined>;

/**
 * Proactive workflow-divergence notifier.
 *
 * After local telemetry refreshes, this scans the SETTLED user-request turns of
 * recently-active sessions — across ALL ENABLED {@link SessionDataSource}s
 * (Copilot SQLite + Claude Code transcripts) — in repositories that have
 * configured workflows, and raises a notification for each NEW divergence (a step
 * skipped or out of order). It is the source-agnostic glue around the per-turn
 * detector and the pure {@link ../deviation/divergenceNotices} dedup/settle
 * helpers; gated by `agentObservability.deviation.notifyOnDivergence` (off by
 * default). Its sole `vscode` dependency — showing the toast — is injected as
 * {@link ShowDivergenceWarning}, so the scan/dedup logic is unit-testable headless.
 *
 * Per source, workflow content predicates read raw content through that source's
 * own LOCAL-ONLY {@link SessionDataSource.getSessionContent} (Copilot from span
 * attributes, Claude reconstructed from the transcript); a source that supplies
 * none leaves content predicates inert (the sequence/missing/timeout checks still
 * run over metadata). Matched content is never stored on a deviation and never
 * synced — content-derived deviations stay local, and these notifications are
 * local UI, so surfacing them keeps that boundary intact.
 *
 * De-dup + baseline: the FIRST scan only records the current divergences as a
 * silent baseline (so a fresh window — or newly-changed workflows — never floods
 * the user with toasts for pre-existing history); subsequent scans notify only
 * divergences not seen before. The {@link divergenceKey} incorporates the source
 * id, so a Claude session and a Copilot session with the same key can never
 * collide in the {@link seen} set. SETTLED-turn filtering avoids reporting an
 * in-flight task as "missing later steps".
 */
export class WorkflowDivergenceNotifier {
  private seen = new Set<string>();
  private primed = false;

  constructor(
    private readonly config: Pick<Configuration, 'isNotifyOnDivergenceEnabled' | 'getWorkflowConfigs'>,
    // Only `enabled()` is used; narrowing keeps the notifier off the full registry
    // (and its context-analysis/database import chain) so it stays headless-testable.
    private readonly sources: Pick<SourceRegistry, 'enabled'>,
    private readonly deviations: LocalDeviationDetector,
    private readonly openSession: (sourceId: string, sessionKey: string) => void,
    private readonly showWarning: ShowDivergenceWarning,
  ) {}

  /** Refreshable hook: invoked after each telemetry refresh fan-out. */
  refresh(): void {
    this.scan();
  }

  /**
   * Re-prime the baseline (e.g. after the workflows setting changed), so the next
   * scan adopts the now-current divergences silently rather than notifying for
   * every historical turn the new configuration happens to match.
   */
  resetBaseline(): void {
    this.primed = false;
    this.seen.clear();
  }

  /** Scan + notify. No-op when the setting is off or no workflows are configured. */
  scan(): void {
    if (!this.config.isNotifyOnDivergenceEnabled()) {
      return;
    }
    const configs = this.config.getWorkflowConfigs();
    if (configs.length === 0) {
      return;
    }
    const configuredRepos = new Set(configs.map((c) => c.repository.toLowerCase()));
    const located = this.collectSettledDivergences(configuredRepos);

    if (!this.primed) {
      this.seen = new Set(located.map(divergenceKey));
      this.primed = true;
      return;
    }
    const { toNotify, nextSeen } = selectNewDivergences(located, this.seen);
    this.seen = nextSeen;
    this.notify(toNotify);
  }

  /**
   * Collect divergences from settled turns of recent sessions in configured repos,
   * across every ENABLED source. Each source bounds its own session list
   * ({@link SCAN_SESSION_LIMIT}); a source whose listing fails is skipped so one
   * unreadable source never blanks the others.
   */
  private collectSettledDivergences(configuredRepos: ReadonlySet<string>): LocatedDivergence[] {
    const now = Date.now();
    const located: LocatedDivergence[] = [];
    for (const source of this.sources.enabled()) {
      const sessions = source.listSessions(undefined, SCAN_SESSION_LIMIT);
      if (!sessions.ok) {
        continue;
      }
      for (const summary of sessions.value) {
        if (!configuredRepos.has(summary.repository.toLowerCase())) {
          continue;
        }
        located.push(
          ...this.divergencesForSession(source, summary.sessionId, summary.endedAtMs, now),
        );
      }
    }
    return located;
  }

  /** Per-turn divergences for one session of one source, restricted to SETTLED turns. */
  private divergencesForSession(
    source: SessionDataSource,
    sessionKey: string,
    sessionEndMs: number,
    nowMs: number,
  ): LocatedDivergence[] {
    const detailResult = source.getSessionDetail(sessionKey);
    if (!detailResult.ok) {
      return [];
    }
    const interactionsResult = source.getSessionInteractions(sessionKey);
    if (!interactionsResult.ok) {
      return [];
    }
    const detail = detailResult.value;
    const turnStarts = detail.turns.map((t) => t.timestampMs);
    if (turnStarts.length === 0) {
      return [];
    }

    // Memoized LOCAL-ONLY content lookup, mirroring the detail panel: each source
    // supplies its own content (Copilot from span attributes, Claude reconstructed
    // from the transcript); a source that implements no lookup — or returns a
    // failure — leaves content predicates inert (metadata-only matching).
    const attributeCache = new Map<string, ReadonlyMap<string, string>>();
    const contentLookup = (attribute: string): ReadonlyMap<string, string> => {
      let values = attributeCache.get(attribute);
      if (values === undefined) {
        const result = source.getSessionContent?.(sessionKey, attribute);
        values = result?.ok ? result.value : new Map<string, string>();
        attributeCache.set(attribute, values);
      }
      return values;
    };

    const turns = groupInteractionsByTurn(interactionsResult.value, turnStarts);
    const perTurn = this.deviations.detectForTurns(turns, contentLookup);
    const settled = new Set(settledTurnIndices(turnStarts, sessionEndMs, nowMs, SETTLE_MS));

    const located: LocatedDivergence[] = [];
    perTurn.forEach((list, i) => {
      if (!settled.has(i)) {
        return;
      }
      for (const deviation of list) {
        located.push({ sourceId: source.id, sessionKey, turnStartMs: turnStarts[i], deviation });
      }
    });
    return located;
  }

  /** Show a warning toast per new divergence (capped), with an Open-session action. */
  private notify(toNotify: readonly LocatedDivergence[]): void {
    const shown = toNotify.slice(0, MAX_NOTICES_PER_SCAN);
    for (const item of shown) {
      const message =
        `Workflow “${item.deviation.workflowName}” diverged ` +
        `(${item.deviation.type}): ${item.deviation.description}`;
      void this.showWarning(message, 'Open session').then((choice) => {
        if (choice === 'Open session') {
          this.openSession(item.sourceId, item.sessionKey);
        }
      });
    }
    const extra = toNotify.length - shown.length;
    if (extra > 0) {
      void this.showWarning(
        `+${extra} more workflow divergence(s) detected. Open Agent Observability to review them.`,
      );
    }
  }
}
