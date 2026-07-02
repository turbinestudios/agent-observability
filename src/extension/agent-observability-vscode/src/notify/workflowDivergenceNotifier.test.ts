import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkflowDivergenceNotifier } from './workflowDivergenceNotifier';
import { LocalDeviationDetector } from '../deviation/localDeviations';
import { DeviationType, WorkflowConfig } from '../deviation/models';
import type { SessionDataSource, SourceRegistry } from '../sources/sessionSource';
import type { Interaction, SessionDetail, SessionSummary } from '../telemetry/models';

/**
 * The notifier is exercised through a fake Claude {@link SessionDataSource} so the
 * whole scan/settle/baseline/dedup path runs headless (no `vscode`, no SQLite).
 * The one thing that matters for THIS suite is that a source-agnostic
 * content-triggered workflow — one that gates on the user's PROMPT, reconstructed
 * for Claude via `getSessionContent` — produces a notice for a Claude session,
 * exactly as the Copilot path already does, while the settle/baseline guards still
 * suppress the first scan.
 */

const REPO = 'https://github.com/org/repo';
const BASE = 1_700_000_000_000;
const SESSION_KEY = 'claude-sess-1';
const PROMPT_SPAN = 'span-req-1';
const SETTLE_MS = 30_000;

/** A workflow gated on the prompt content, with one metadata step that never matches. */
const CONTENT_TRIGGERED: WorkflowConfig = {
  repository: REPO,
  workflows: [
    {
      name: 'implement-feature',
      expectedSequence: [],
      maxDurationMs: 3_600_000,
      sequenceDeviationAlert: true,
      timeoutExceededAlert: false,
      toolUsageAnomalyAlert: false,
      // Relevance keys on WHAT the user asked (a slash command), not metadata.
      triggerContentPredicate: { attribute: 'copilot_chat.user_request', contains: '/implement-feature' },
      // No interaction in the turn is a `test-runner` tool call, so this step is
      // always missing → a MissingSteps divergence whenever the workflow applies.
      steps: [{ name: 'run-tests', predicate: { toolName: 'test-runner' } }],
    },
  ],
};

/** Config satisfying both the notifier and the detector. */
function makeConfig() {
  return {
    isNotifyOnDivergenceEnabled: () => true,
    getWorkflowConfigs: () => [CONTENT_TRIGGERED],
    getMaxSessionMinutes: () => 60,
  };
}

/** The single chat interaction anchoring the turn (carries the prompt span id). */
function chatInteraction(): Interaction {
  return {
    timestampMs: BASE,
    sessionId: SESSION_KEY,
    traceId: 'trace-1',
    spanId: PROMPT_SPAN,
    operation: 'chat',
    agentName: 'claude',
    agentMode: 'agent',
    model: 'claude-opus-4-8',
    durationMs: 1_000,
    success: true,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    repository: REPO,
  };
}

/** A session whose only turn starts (and ends) at {@link BASE}. */
function summary(): SessionSummary {
  // The notifier reads only sessionId / repository / endedAtMs off the summary;
  // a focused cast avoids fabricating the full rollup.
  return {
    sessionId: SESSION_KEY,
    repository: REPO,
    startedAtMs: BASE,
    endedAtMs: BASE,
  } as unknown as SessionSummary;
}

function unused(): never {
  throw new Error('not exercised by the notifier');
}

/**
 * A fake Claude source. `listSessions` returns whatever `sessions` currently holds
 * (so a test can make a session APPEAR between scans); `getSessionContent`
 * reconstructs the prompt text for the trigger, mirroring ClaudeCodeService.
 */
function claudeSource(sessions: () => SessionSummary[]): SessionDataSource {
  return {
    id: 'claude',
    label: 'Claude Code',
    isEnabled: () => true,
    listSessions: () => ({ ok: true, value: sessions() }),
    getSessionDetail: () => ({
      // The notifier reads only detail.turns[].timestampMs.
      ok: true,
      value: { turns: [{ timestampMs: BASE }] } as unknown as SessionDetail,
    }),
    getSessionInteractions: () => ({ ok: true, value: [chatInteraction()] }),
    getSessionContent: (_sessionKey, attribute) => ({
      ok: true,
      value:
        attribute === 'copilot_chat.user_request'
          ? new Map([[PROMPT_SPAN, 'please run the /implement-feature workflow']])
          : new Map<string, string>(),
    }),
    getOverview: () => unused(),
    listRepositories: () => unused(),
    getAggregationRows: () => unused(),
    refresh: () => {},
    dispose: () => {},
  };
}

interface Harness {
  notifier: WorkflowDivergenceNotifier;
  showWarning: ReturnType<typeof vi.fn>;
  openSession: ReturnType<typeof vi.fn>;
}

/** Wire a notifier over a single fake Claude source and captured UI seams. */
function harness(sessions: () => SessionSummary[]): Harness {
  const config = makeConfig();
  const detector = new LocalDeviationDetector(config);
  const source = claudeSource(sessions);
  const registry: Pick<SourceRegistry, 'enabled'> = { enabled: () => [source] };
  const showWarning = vi.fn(
    (_message: string, _action?: string): Promise<string | undefined> => Promise.resolve('Open session'),
  );
  const openSession = vi.fn();
  const notifier = new WorkflowDivergenceNotifier(config, registry, detector, openSession, showWarning);
  return { notifier, showWarning, openSession };
}

/** Let the injected showWarning `.then(...)` action callbacks run. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('WorkflowDivergenceNotifier', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('primes a silent baseline: the first scan raises no toast even when a Claude session already diverges', () => {
    vi.setSystemTime(BASE + SETTLE_MS + 10_000); // the turn is already settled
    const { notifier, showWarning } = harness(() => [summary()]);

    notifier.scan();
    expect(showWarning).not.toHaveBeenCalled();

    // A second scan of the same, already-baselined divergence still says nothing.
    notifier.scan();
    expect(showWarning).not.toHaveBeenCalled();
  });

  it('toasts a NEW content-triggered Claude divergence once its turn settles, then dedups, and routes Open-session to the Claude source', async () => {
    const { notifier, showWarning, openSession } = harness(() => [summary()]);

    // Scan 1 — the turn has not settled yet: nothing collected, baseline empty.
    vi.setSystemTime(BASE + 10_000);
    notifier.scan();
    expect(showWarning).not.toHaveBeenCalled();

    // Scan 2 — still inside the settle window: an in-flight turn is not reported.
    vi.setSystemTime(BASE + 20_000);
    notifier.scan();
    expect(showWarning).not.toHaveBeenCalled();

    // Scan 3 — settled and NEW relative to the (empty) baseline: one toast fires.
    vi.setSystemTime(BASE + SETTLE_MS + 10_000);
    notifier.scan();
    expect(showWarning).toHaveBeenCalledTimes(1);
    const [message, action] = showWarning.mock.calls[0];
    expect(message).toContain('implement-feature');
    expect(message).toContain(DeviationType.MissingSteps);
    expect(action).toBe('Open session');

    // The Open-session action routes to the CLAUDE source, not a hard-coded copilot.
    await flushMicrotasks();
    expect(openSession).toHaveBeenCalledWith('claude', SESSION_KEY);

    // Scan 4 — same divergence, already seen: no additional toast.
    vi.setSystemTime(BASE + SETTLE_MS + 20_000);
    notifier.scan();
    expect(showWarning).toHaveBeenCalledTimes(1);
  });

  it('stays silent when the notify setting is off (never even primes)', () => {
    vi.setSystemTime(BASE + SETTLE_MS + 10_000); // settled — so only the gate suppresses it
    const config = { ...makeConfig(), isNotifyOnDivergenceEnabled: () => false };
    const detector = new LocalDeviationDetector(makeConfig());
    const source = claudeSource(() => [summary()]);
    const showWarning = vi.fn(
      (_message: string, _action?: string): Promise<string | undefined> => Promise.resolve(undefined),
    );
    const off = new WorkflowDivergenceNotifier(
      config,
      { enabled: () => [source] },
      detector,
      vi.fn(),
      showWarning,
    );
    off.scan();
    off.scan();
    expect(showWarning).not.toHaveBeenCalled();
  });
});
