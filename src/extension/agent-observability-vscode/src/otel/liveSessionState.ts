import { LiveFields } from './otlpParse';

/**
 * The live status snapshot pushed to a session-detail webview. Plain JSON (it
 * crosses the `postMessage` boundary); the webview renders it via `textContent`
 * only, so no value here is ever interpreted as markup.
 */
export interface LiveSessionPayload {
  /** Every id this session is known by, for routing to the matching open panel. */
  candidateIds: string[];
  startedAtMs: number;
  lastActivityMs: number;
  llmCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  model?: string;
  turn?: number;
  subagents: string[];
  /** A short human description of the most recent meaningful activity. */
  currentActivity: string;
}

interface LiveState {
  ids: Set<string>;
  startedAtMs: number;
  lastActivityMs: number;
  llmCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  model?: string;
  turn?: number;
  subagents: Set<string>;
  currentActivity: string;
}

function newState(): LiveState {
  return {
    ids: new Set<string>(),
    startedAtMs: Number.POSITIVE_INFINITY,
    lastActivityMs: 0,
    llmCalls: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    model: undefined,
    turn: undefined,
    subagents: new Set<string>(),
    currentActivity: '',
  };
}

/**
 * Folds a stream of parsed OTel {@link LiveFields} into a running per-session
 * aggregate. A session may emit spans carrying different ids over its lifetime
 * (resource `session.id` on some, `gen_ai.conversation.id` on others), so state
 * is merged whenever a new span shares ANY previously-seen id, and the same
 * {@link LiveState} object is indexed under every id it is known by. The
 * `currentActivity` reflects the last meaningful span (chat / tool / subagent),
 * applied in file order.
 */
export class LiveSessionAggregator {
  private readonly byId = new Map<string, LiveState>();

  /**
   * Apply one span's fields. Returns a stable id for the touched session (so the
   * caller can fetch + push it once per batch), or `undefined` when the span
   * carried no usable id.
   */
  apply(f: LiveFields): string | undefined {
    if (f.candidateIds.length === 0) {
      return undefined;
    }
    // Reuse existing state if any candidate id is already known; else start one.
    let state: LiveState | undefined;
    for (const id of f.candidateIds) {
      state = this.byId.get(id);
      if (state !== undefined) {
        break;
      }
    }
    if (state === undefined) {
      state = newState();
    }

    this.merge(state, f);

    // (Re-)index the state under all of its known ids so future spans + routing
    // resolve to the same object regardless of which id they carry.
    for (const id of state.ids) {
      this.byId.set(id, state);
    }
    return f.candidateIds[0];
  }

  get(id: string): LiveState | undefined {
    return this.byId.get(id);
  }

  private merge(state: LiveState, f: LiveFields): void {
    for (const id of f.candidateIds) {
      state.ids.add(id);
    }

    const ts = f.timestampMs ?? Date.now();
    if (ts < state.startedAtMs) {
      state.startedAtMs = ts;
    }
    if (ts > state.lastActivityMs) {
      state.lastActivityMs = ts;
    }

    if (f.turn !== undefined) {
      state.turn = state.turn === undefined ? f.turn : Math.max(state.turn, f.turn);
    }
    if (f.subagentName !== undefined) {
      state.subagents.add(f.subagentName);
    }

    switch (f.operation) {
      case 'chat':
        state.llmCalls += 1;
        state.inputTokens += f.inputTokens;
        state.outputTokens += f.outputTokens;
        state.cachedTokens += f.cachedTokens;
        if (f.model !== undefined) {
          state.model = f.model;
        }
        state.currentActivity = `Model ${f.model ?? state.model ?? ''}`.trim()
          + (state.turn !== undefined ? ` · turn ${state.turn}` : '');
        break;
      case 'execute_tool':
        state.toolCalls += 1;
        state.currentActivity = `Tool: ${f.toolName ?? f.spanName}`;
        break;
      default:
        // Sub-agent spawns are the only non-chat/tool event worth surfacing as
        // the current activity; everything else (hooks, discovery) is noise here.
        if (f.subagentName !== undefined) {
          state.currentActivity = `Sub-agent: ${f.subagentName}`;
        }
        break;
    }
  }

  toPayload(state: LiveState): LiveSessionPayload {
    return {
      candidateIds: [...state.ids],
      startedAtMs: Number.isFinite(state.startedAtMs) ? state.startedAtMs : state.lastActivityMs,
      lastActivityMs: state.lastActivityMs,
      llmCalls: state.llmCalls,
      toolCalls: state.toolCalls,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      cachedTokens: state.cachedTokens,
      totalTokens: state.inputTokens + state.outputTokens,
      model: state.model,
      turn: state.turn,
      subagents: [...state.subagents],
      currentActivity: state.currentActivity.length > 0 ? state.currentActivity : 'Working…',
    };
  }
}
