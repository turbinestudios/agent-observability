import * as vscode from 'vscode';
import { Configuration } from '../config/configuration';
import { TelemetryService } from '../telemetry/telemetryService';
import { LocalDeviationDetector } from '../deviation/localDeviations';
import { groupInteractionsByTurn } from '../deviation/turnGrouping';
import {
  LocatedDivergence,
  divergenceKey,
  selectNewDivergences,
  settledTurnIndices,
} from '../deviation/divergenceNotices';

/** How long after a turn ends before a divergence in it is reportable (anti-mid-task). */
const SETTLE_MS = 30_000;
/** How many recent sessions to scan per pass (the source DB is a short rolling window). */
const SCAN_SESSION_LIMIT = 50;
/** Cap individual toasts per scan; the remainder collapses into one summary toast. */
const MAX_NOTICES_PER_SCAN = 4;

/**
 * Proactive workflow-divergence notifier.
 *
 * After local telemetry refreshes, this scans the SETTLED user-request turns of
 * recently-active sessions in repositories that have configured workflows, and
 * raises a VS Code notification for each NEW divergence (a step skipped or out of
 * order). It is the `vscode`-bound glue around the per-turn detector and the pure
 * {@link ../deviation/divergenceNotices} dedup/settle helpers; gated by
 * `agentObservability.deviation.notifyOnDivergence` (off by default).
 *
 * De-dup + baseline: the FIRST scan only records the current divergences as a
 * silent baseline (so a fresh window — or newly-changed workflows — never floods
 * the user with toasts for pre-existing history); subsequent scans notify only
 * divergences not seen before. SETTLED-turn filtering avoids reporting an
 * in-flight task as "missing later steps".
 */
export class WorkflowDivergenceNotifier {
  private seen = new Set<string>();
  private primed = false;

  constructor(
    private readonly config: Configuration,
    private readonly telemetry: TelemetryService,
    private readonly deviations: LocalDeviationDetector,
    private readonly openSession: (sessionKey: string) => void,
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

  /** Collect divergences from settled turns of recent sessions in configured repos. */
  private collectSettledDivergences(configuredRepos: ReadonlySet<string>): LocatedDivergence[] {
    const sessions = this.telemetry.listSessions(undefined, SCAN_SESSION_LIMIT);
    if (!sessions.ok) {
      return [];
    }
    const now = Date.now();
    const located: LocatedDivergence[] = [];
    for (const summary of sessions.value) {
      if (!configuredRepos.has(summary.repository.toLowerCase())) {
        continue;
      }
      located.push(...this.divergencesForSession(summary.sessionId, summary.endedAtMs, now));
    }
    return located;
  }

  /** Per-turn divergences for one session, restricted to SETTLED turns. */
  private divergencesForSession(
    sessionKey: string,
    sessionEndMs: number,
    nowMs: number,
  ): LocatedDivergence[] {
    const detailResult = this.telemetry.getSessionDetail(sessionKey);
    if (!detailResult.ok) {
      return [];
    }
    const interactionsResult = this.telemetry.getSessionInteractions(sessionKey);
    if (!interactionsResult.ok) {
      return [];
    }
    const detail = detailResult.value;
    const turnStarts = detail.turns.map((t) => t.timestampMs);
    if (turnStarts.length === 0) {
      return [];
    }

    const attributeCache = new Map<string, ReadonlyMap<string, string>>();
    const contentLookup = (attribute: string): ReadonlyMap<string, string> => {
      let values = attributeCache.get(attribute);
      if (values === undefined) {
        const result = this.telemetry.getSpanAttributes(sessionKey, attribute);
        values = result.ok ? result.value : new Map<string, string>();
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
        located.push({ sessionKey, turnStartMs: turnStarts[i], deviation });
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
      void vscode.window.showWarningMessage(message, 'Open session').then((choice) => {
        if (choice === 'Open session') {
          this.openSession(item.sessionKey);
        }
      });
    }
    const extra = toNotify.length - shown.length;
    if (extra > 0) {
      void vscode.window.showWarningMessage(
        `+${extra} more workflow divergence(s) detected. Open Agent Observability to review them.`,
      );
    }
  }
}
