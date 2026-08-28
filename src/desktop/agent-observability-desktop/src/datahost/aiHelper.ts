import type { SourceRegistry } from '@agent-observability/core/src/sources/sessionSource';
import type { ChatBackend } from '@agent-observability/core/src/chat/backends/chatBackend';
import type { CancellationToken } from '@agent-observability/core/src/chat/backends/cancellation';
import type { AssembledMessage } from '@agent-observability/core/src/chat/conversation';
import {
  Conversation,
  assembleMessages,
  truncateHistory,
} from '@agent-observability/core/src/chat/conversation';
import { isCancellation } from '@agent-observability/core/src/chat/lmErrors';
import { markdownToHtml } from '@agent-observability/core/src/chat/webview/markdownToHtml';
import {
  ASSISTANT_QUICK_PROMPTS,
  CORPUS_SESSION_LIMIT,
  HISTORY_MAX_CHARS,
  buildAssistantPreamble,
  buildSessionRefMap,
  type AssistantFocus,
  type AssistantSessionRow,
  type SessionRefTarget,
} from '@agent-observability/core/src/chat/tasks/assistantGrounding';
import {
  DEEP_RETRO_CAPS,
  buildTranscriptDigest,
} from '@agent-observability/core/src/chat/tasks/transcriptDigest';
import type {
  AiChatState,
  AiSendParams,
  AiSendResult,
  RpcEvent,
  SessionRef,
  SessionRow,
} from '../shared/rpc';
import { manualToken } from './cancellation';
import type { HiddenStore } from './hidden';
import type { IndexDb } from './indexer/indexDb';
import type { RenameStore } from './renames';
import type { DesktopSettingsReader } from './drivers/desktopConfig';

/**
 * The AI Helper controller — one of the two sanctioned places this app sends
 * session content to a model (the other is the deep retrospective,
 * `deepRetro.ts`); see the privacy invariant in AGENTS.md.
 *
 * Consent is enforced in depth: the renderer shows a first-use notice before
 * any send, and this module INDEPENDENTLY refuses while the acknowledgement
 * key is unset, so no renderer bug can turn an unacknowledged message into a
 * network transmission. Every send goes through the user's own `claude` CLI
 * (their login, no API key), tools disabled, one turn, no session persistence.
 *
 * The thread lives only in this process's memory: it survives view switches
 * within an app run and is gone on restart, matching core's design decision
 * that chat transcripts are never persisted to disk.
 */

/** Settings key recording that the first-use notice was accepted. Desktop-only. */
export const AI_HELPER_ACK_KEY = 'aiHelper.disclosed';

/** Safety net only — Stop is the real control for a runaway answer. */
const AI_SEND_TIMEOUT_MS = 300_000;

/** Matches the extension's render throttle: full re-render per tick, ~16 fps. */
const RENDER_THROTTLE_MS = 60;

/** Structural picks of the real collaborators, so tests can fake them flat. */
export interface AiHelperDeps {
  db: Pick<IndexDb, 'listSessions' | 'getRow'>;
  sources: Pick<SourceRegistry, 'get'>;
  settings: Pick<DesktopSettingsReader, 'get' | 'update'>;
  renames: Pick<RenameStore, 'apply'>;
  hidden: Pick<HiddenStore, 'all'>;
  /** Accessor rather than an instance — the registry is rebuilt on AI settings changes. */
  backend: () => ChatBackend;
  emit: (event: RpcEvent) => void;
  /** Injectable stream seam so tests never run the real CLI. */
  streamSeam?: (
    messages: readonly AssembledMessage[],
    onDelta: (text: string) => void,
    token: CancellationToken,
  ) => Promise<void>;
}

export class AiHelperController {
  private readonly conversation = new Conversation();
  private busy = false;
  private runId = 0;
  private focus: SessionRef | undefined;
  private cancelInFlight: (() => void) | undefined;
  /** Ref map of the latest send, for re-linkifying citations on `state()`. */
  private refMap: ReadonlyMap<string, SessionRefTarget> = new Map();

  constructor(private readonly deps: AiHelperDeps) {}

  state(): AiChatState {
    return {
      messages: this.conversation.history.map((message) =>
        message.role === 'assistant'
          ? { role: message.role, text: message.text, html: this.renderAssistant(message.text) }
          : { role: message.role, text: message.text },
      ),
      busy: this.busy,
      runId: this.runId,
      acknowledged: this.acknowledged(),
      ...(this.focus !== undefined ? { focus: this.focus } : {}),
    };
  }

  acknowledge(): void {
    this.deps.settings.update({ [AI_HELPER_ACK_KEY]: true });
  }

  /** Cancel the in-flight send; the partial answer stays in the transcript. */
  stop(): void {
    this.cancelInFlight?.();
  }

  /** "New chat": drop the thread, the focus session, and any stale deltas. */
  reset(): void {
    this.stop();
    this.conversation.clear();
    this.focus = undefined;
    this.runId++;
  }

  async send(params: AiSendParams): Promise<AiSendResult> {
    if (this.busy) {
      return { ok: false, error: 'An answer is already streaming — stop it first or wait for it to finish.' };
    }
    // Enforced here as well as in the view: the notice is the consent gate,
    // and no renderer bug may bypass it.
    if (!this.acknowledged()) {
      return { ok: false, error: 'Accept the AI Helper notice before sending.' };
    }
    const text = this.resolveText(params);
    if (text === undefined) {
      return { ok: false, error: 'Nothing to send.' };
    }
    // Claimed before the first await: two rapid sends must not both pass the
    // busy check while the availability probe is in flight.
    this.busy = true;
    try {
      return await this.run(params, text);
    } finally {
      this.busy = false;
      this.cancelInFlight = undefined;
    }
  }

  private async run(params: AiSendParams, text: string): Promise<AiSendResult> {
    // The send owns the attach state: present sets it, absent clears it, so
    // the chip in the view and what is actually sent can never disagree.
    this.focus = params.focus;

    const availability = await this.deps.backend().isAvailable();
    if (!availability.available) {
      return { ok: false, error: availability.reason };
    }

    const grounding = this.buildGrounding();
    if ('error' in grounding) {
      return { ok: false, error: grounding.error };
    }
    this.refMap = grounding.refMap;

    // Appended only once every refusal is behind us: a failed send leaves the
    // typed text in the input box, not as a dangling turn in the thread.
    this.conversation.append('user', text);
    const { history, truncated } = truncateHistory(this.conversation.history, HISTORY_MAX_CHARS);
    const messages = assembleMessages(
      buildAssistantPreamble(grounding.rows, grounding.focus, truncated, Date.now()),
      history,
    );

    this.runId++;
    const runId = this.runId;
    const manual = manualToken();
    let stopped = false;
    let timedOut = false;
    this.cancelInFlight = () => {
      stopped = true;
      manual.cancel();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      manual.cancel();
    }, AI_SEND_TIMEOUT_MS);

    let accumulated = '';
    let pendingEmit: ReturnType<typeof setTimeout> | undefined;
    const emitNow = (): void => {
      pendingEmit = undefined;
      this.deps.emit({ event: 'ai.assistantDelta', runId, html: this.renderAssistant(accumulated) });
    };
    const onDelta = (delta: string): void => {
      accumulated += delta;
      pendingEmit ??= setTimeout(emitNow, RENDER_THROTTLE_MS);
    };

    const stream =
      this.deps.streamSeam ??
      ((m: readonly AssembledMessage[], d: (t: string) => void, t: CancellationToken) =>
        this.deps.backend().streamChat({ messages: m }, d, t));

    try {
      await stream(messages, onDelta, manual.token);
      this.keepAnswer(accumulated);
      return { ok: true };
    } catch (err) {
      // Whatever streamed before the failure was already on screen; keeping it
      // in the thread keeps the transcript honest.
      this.keepAnswer(accumulated);
      if (stopped || isCancellation(err)) {
        return { ok: true, cancelled: true };
      }
      if (timedOut) {
        return { ok: false, error: 'The AI Helper timed out. Try a shorter question, or ask again.' };
      }
      return { ok: false, error: this.deps.backend().describeError(err).message };
    } finally {
      clearTimeout(timer);
      if (pendingEmit !== undefined) {
        clearTimeout(pendingEmit);
      }
      // The closing emit paints the final markup even when the last delta
      // landed inside the throttle window.
      this.deps.emit({ event: 'ai.assistantDelta', runId, html: this.renderAssistant(accumulated) });
    }
  }

  private acknowledged(): boolean {
    return this.deps.settings.get<boolean>(AI_HELPER_ACK_KEY, false) === true;
  }

  private resolveText(params: AiSendParams): string | undefined {
    const typed = params.text?.trim() ?? '';
    if (typed.length > 0) {
      return typed;
    }
    const quick = ASSISTANT_QUICK_PROMPTS.find((p) => p.id === params.quickPromptId);
    return quick?.prompt;
  }

  /** Assemble the corpus rows (renames applied, hidden excluded) and the focus digest. */
  private buildGrounding():
    | { rows: AssistantSessionRow[]; focus?: AssistantFocus; refMap: Map<string, SessionRefTarget> }
    | { error: string } {
    const hiddenKeys = this.deps.hidden.all();
    const listed = this.deps.renames.apply(
      this.deps.db.listSessions({ limit: CORPUS_SESSION_LIMIT }, hiddenKeys),
    );
    const rows = listed.map((row, index) => toAssistantRow(row, `S${index + 1}`));

    let focus: AssistantFocus | undefined;
    if (this.focus !== undefined) {
      const { source, sessionId } = this.focus;
      const dataSource = this.deps.sources.get(source);
      if (dataSource === undefined) {
        return { error: `Unknown source: ${source}` };
      }
      const detail = dataSource.getSessionDetail(sessionId);
      if (!detail.ok) {
        return { error: detail.message };
      }
      const indexed = this.deps.db.getRow(source, sessionId);
      const known = rows.find((r) => r.source === source && r.sessionId === sessionId);
      const row =
        known ??
        (indexed !== undefined
          ? toAssistantRow(this.deps.renames.apply([indexed])[0], `S${rows.length + 1}`)
          : undefined);
      if (row === undefined) {
        return { error: 'That session is not in the index yet — refresh and try again.' };
      }
      focus = { row, digest: buildTranscriptDigest(detail.value.turns, DEEP_RETRO_CAPS) };
    }

    return { rows, ...(focus !== undefined ? { focus } : {}), refMap: buildSessionRefMap(rows, focus) };
  }

  private keepAnswer(accumulated: string): void {
    if (accumulated.trim().length > 0) {
      this.conversation.append('assistant', accumulated);
    }
  }

  private renderAssistant(text: string): string {
    return linkifyCitations(markdownToHtml(text), this.refMap);
  }
}

/** Map an indexed list row to the assistant's citation-ready projection. */
function toAssistantRow(row: SessionRow, ref: string): AssistantSessionRow {
  return {
    ref,
    source: row.source,
    sessionId: row.sessionId,
    ...(row.title !== undefined ? { title: row.title } : {}),
    repository: row.repository,
    startedAtMs: row.startedAtMs,
    durationMs: row.durationMs,
    interactionCount: row.interactionCount,
    toolCalls: row.toolCalls,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    model: row.model,
    ...(row.verdict !== undefined ? { verdict: row.verdict } : {}),
    ...(row.deviationCount !== undefined ? { deviationCount: row.deviationCount } : {}),
    ...(row.costMicros !== undefined ? { costMicros: row.costMicros } : {}),
  };
}

/**
 * Turn known `[S7]` refs in host-rendered HTML into `<a data-source data-id>`
 * anchors (no `href`, so a citation can never navigate the window), labeled
 * with the session's name rather than the bare ref — the model cites in refs,
 * the user reads names. Text inside `<code>`/`<pre>` is left alone — a ref
 * quoted in code is a quote, not a citation — and unknown refs stay plain text.
 */
export function linkifyCitations(
  html: string,
  refs: ReadonlyMap<string, SessionRefTarget>,
): string {
  if (refs.size === 0 || !html.includes('[S')) {
    return html;
  }
  const parts = html.split(/(<[^>]*>)/);
  let codeDepth = 0;
  return parts
    .map((part) => {
      if (part.startsWith('<')) {
        if (/^<(code|pre)\b/i.test(part)) {
          codeDepth++;
        } else if (/^<\/(code|pre)\s*>/i.test(part)) {
          codeDepth = Math.max(0, codeDepth - 1);
        }
        return part;
      }
      if (codeDepth > 0) {
        return part;
      }
      return part.replace(/\[(S\d+)\]/g, (whole, ref: string) => {
        const target = refs.get(ref);
        if (target === undefined) {
          return whole;
        }
        return (
          `<a class="session-ref" title="Open this session" data-source="${escapeAttr(target.source)}"` +
          ` data-id="${escapeAttr(target.sessionId)}">${escapeAttr(target.label)}</a>`
        );
      });
    })
    .join('');
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
