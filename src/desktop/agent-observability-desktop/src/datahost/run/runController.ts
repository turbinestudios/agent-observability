import { randomUUID } from 'node:crypto';
import {
  RUN_PERMISSION_TEXT_MAX,
  type RunAvailability,
  type RunDoor,
  type RunEventChange,
  type RunInputRequest,
  type RunItem,
  type RunLiveState,
  type RunPermissionDecision,
  type RunPermissionMode,
  type RunPermissionRequest,
  type RunSessionInfo,
  type RunStatus,
  type RunTranscript,
} from '../../shared/runTypes';
import { scopeCovers, scopeLabel, type SessionScope } from './permissionScope';
import type { DriverEvent, DriverPermission, RunDriver } from './runDriver';

/**
 * The run host: the sessions the app is hosting, their exact status, and the
 * requests waiting on the user.
 *
 * It owns no agent logic. A driver reports what the runtime does; this class
 * turns that into a status, a transcript and — for anything the agent may not
 * do unasked — a parked request that only the user's answer releases. It
 * writes no index rows: a hosted session reaches the index the way every
 * Copilot CLI session does, through its own files on disk, so it is counted
 * once.
 *
 * Permissions. By default every request is put to the user. Two things can
 * change that, and both are the user's own choice for this one hosted
 * session, held in memory only:
 * - an "Allow for this session" they gave earlier, for requests inside the
 *   scope it named (`permissionScope.ts`);
 * - the session's `allow-all` mode. That is the Copilot CLI's own allow-all,
 *   switched on in the runtime through the driver, so the runtime stops
 *   asking. It only counts once the runtime has taken it: if a policy
 *   refuses, the session stays in the asking mode and says so. Requests that
 *   were already waiting, or that the runtime still raises, are approved
 *   here one at a time, except one the runtime marks as needing the user (an
 *   organisation policy, leaving the sandbox), which is always shown.
 * Allow all ends with the hosted session, and when the session loses its CLI.
 *
 * The agent can ask for several things at once, so requests wait in a queue:
 * one is shown, the rest stay parked until it is answered.
 *
 * Gates: nothing starts, resumes or is sent unless Run is enabled in Settings
 * AND the first-use notice was acknowledged; an approval, standing or not, is
 * refused under the same rule. Stopping, closing and denying are always
 * allowed.
 */

export const RUN_FLUSH_MS = 120;
export const RUN_TITLE_MAX = 80;
export const RUN_GOAL_MAX = 60_000;

export interface RunTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RunRecord {
  sessionId: string;
  cwd: string;
  repository: string;
  startedAtMs: number;
  door: RunDoor;
}

export interface RunControllerDeps {
  driver: RunDriver;
  emit: (sessionId: string, change: RunEventChange) => void;
  enabled: () => boolean;
  acknowledged: () => boolean;
  /** Host-side Markdown rendering; the renderer owns no Markdown parser. */
  renderMarkdown: (text: string) => string;
  /** Remembers which sessions started here. Holds ids and paths, never text. */
  records?: { add(record: RunRecord): void };
  /** A turn finished: the caller asks the indexer to pick the session up. */
  onTurnEnded?: (sessionId: string) => void;
  now?: () => number;
  timers?: RunTimers;
  newId?: () => string;
  flushMs?: number;
}

/** One request waiting on the user, with what a session approval of it would cover. */
interface Asked {
  request: RunPermissionRequest;
  scope?: SessionScope;
  mustAsk: boolean;
}

interface Hosted {
  info: RunSessionInfo;
  items: RunItem[];
  index: Map<string, number>;
  text: Map<string, string>;
  dirty: Set<string>;
  flush: unknown;
  tools: Map<string, { name: string; startedAtMs: number }>;
  /** Requests waiting on the user, oldest first. Only the first is shown. */
  pending: Asked[];
  /** What the user has allowed for the rest of this session. */
  granted: SessionScope[];
  input?: RunInputRequest;
  usage: { inputTokens: number; outputTokens: number; nanoAiu?: number };
}

export const RUN_MODE_ALLOW_ALL_NOTE =
  'Allow all is on for this session, as with copilot --allow-all. The agent now changes files, runs commands and opens web addresses without asking. You can switch back to Default permissions at any time.';
export const RUN_ALLOW_ALL_REFUSED =
  'Allow all could not be turned on. GitHub Copilot CLI refused it, which usually means your Copilot settings or your organisation turn it off. The session asks before each action.';
export const RUN_ALLOW_ALL_STUCK =
  'GitHub Copilot CLI did not go back to asking. Stop or close the session to be sure nothing more runs unasked.';
export const RUN_MODE_LOST_NOTE =
  'Allow all ended when the session was disconnected. The session asks before each action again; turn Allow all on again if you want it.';
export const RUN_MODE_DEFAULT_NOTE = 'Default permissions are back. The agent asks before each action.';

const REFUSAL_OFF = 'Run is turned off in Settings.';
const REFUSAL_NOTICE = 'Read and accept the Run notice first.';

const defaultTimers: RunTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class RunController {
  private readonly sessions = new Map<string, Hosted>();
  private readonly now: () => number;
  private readonly timers: RunTimers;
  private readonly newId: () => string;

  constructor(private readonly deps: RunControllerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.timers = deps.timers ?? defaultTimers;
    this.newId = deps.newId ?? (() => randomUUID());
  }

  async availability(): Promise<RunAvailability> {
    const enabled = this.deps.enabled();
    const acknowledged = this.deps.acknowledged();
    if (!enabled) {
      // Do not start the user's CLI for a feature that is switched off.
      return { enabled, acknowledged, cliFound: false, models: [] };
    }
    const probe = await this.deps.driver.probe();
    let models: { id: string; label: string }[] = [];
    if (probe.ok) {
      try {
        models = sortModels(await this.deps.driver.listModels());
      } catch {
        models = [];
      }
    }
    return {
      enabled,
      acknowledged,
      cliFound: probe.cliVersion !== undefined || probe.ok,
      ...(probe.cliVersion !== undefined ? { cliVersion: probe.cliVersion } : {}),
      ...(probe.signedIn !== undefined ? { signedIn: probe.signedIn } : {}),
      ...(probe.problem !== undefined ? { problem: probe.problem } : {}),
      models,
    };
  }

  async start(params: {
    goal: string;
    repository: string;
    cwd: string;
    model?: string;
    door: RunDoor;
    permissionMode?: RunPermissionMode;
  }): Promise<RunSessionInfo> {
    this.requireGate();
    const goal = params.goal.trim();
    if (goal.length === 0) {
      throw new Error('Write what the session should do first.');
    }
    if (goal.length > RUN_GOAL_MAX) {
      throw new Error('The goal is too long to send. Shorten it and try again.');
    }
    const hosted = this.open(this.newId(), params);
    this.deps.records?.add({
      sessionId: hosted.info.sessionId,
      cwd: params.cwd,
      repository: params.repository,
      startedAtMs: hosted.info.startedAtMs,
      door: params.door,
    });
    await this.connect(hosted, 'start', params.model);
    if (params.permissionMode === 'allow-all') {
      // Before the goal goes out. If the runtime refuses, the session runs in
      // the asking mode, which is the safe direction, and says why.
      try {
        await this.setPermissionMode(hosted.info.sessionId, 'allow-all');
      } catch (err) {
        this.note(hosted, 'error', err instanceof Error ? err.message : String(err));
      }
    }
    await this.send(hosted.info.sessionId, goal);
    return { ...hosted.info };
  }

  async resume(params: { sessionId: string; repository: string; cwd: string; model?: string }): Promise<RunSessionInfo> {
    this.requireGate();
    const existing = this.sessions.get(params.sessionId);
    if (existing !== undefined) {
      return { ...existing.info };
    }
    const hosted = this.open(params.sessionId, { ...params, goal: '', door: 'continue-session' });
    await this.connect(hosted, 'resume', params.model);
    this.setStatus(hosted, 'idle');
    return { ...hosted.info };
  }

  async send(sessionId: string, text: string): Promise<void> {
    this.requireGate();
    const hosted = this.require(sessionId);
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return;
    }
    if (hosted.info.title === undefined) {
      hosted.info.title = trimmed.split('\n')[0].slice(0, RUN_TITLE_MAX);
    }
    this.upsert(hosted, { kind: 'user', id: `u:${this.newId()}`, text: trimmed, atMs: this.now() });
    this.setStatus(hosted, 'working');
    try {
      await this.deps.driver.send(sessionId, trimmed);
    } catch (err) {
      this.fail(hosted, err);
      throw err;
    }
  }

  async abort(sessionId: string): Promise<void> {
    const hosted = this.sessions.get(sessionId);
    if (hosted === undefined) {
      return;
    }
    this.clearPending(hosted);
    await this.deps.driver.abort(sessionId);
    this.finishStreaming(hosted);
    this.setStatus(hosted, 'stopped');
  }

  /** Stop hosting; the session stays on disk and can be resumed here or in a terminal. */
  async close(sessionId: string): Promise<void> {
    const hosted = this.sessions.get(sessionId);
    if (hosted === undefined) {
      return;
    }
    this.clearPending(hosted);
    this.cancelFlush(hosted);
    this.sessions.delete(sessionId);
    await this.deps.driver.close(sessionId);
    this.deps.emit(sessionId, { type: 'status', status: 'stopped' });
  }

  respondPermission(requestId: string, decision: RunPermissionDecision, feedback?: string): void {
    const hosted = [...this.sessions.values()].find((h) => h.pending.some((a) => a.request.requestId === requestId));
    const at = hosted?.pending.findIndex((a) => a.request.requestId === requestId) ?? -1;
    if (hosted === undefined || at === -1) {
      return; // Already answered, or never asked: ignore.
    }
    const [asked] = hosted.pending.splice(at, 1);
    let effective: RunPermissionDecision = decision;
    if (decision !== 'deny' && !this.gateOpen()) {
      effective = 'deny';
    } else if (decision === 'allow-session' && !asked.request.canAllowSession) {
      effective = 'allow-once';
    }
    if (effective === 'allow-session' && asked.scope !== undefined) {
      hosted.granted.push(asked.scope);
    }
    this.deps.driver.respondPermission(hosted.info.sessionId, requestId, {
      decision: effective,
      ...(effective === 'deny' && feedback !== undefined ? { feedback: feedback.slice(0, RUN_PERMISSION_TEXT_MAX) } : {}),
    });
    this.deps.emit(hosted.info.sessionId, { type: 'permission-cleared', requestId });
    this.settle(hosted);
  }

  /**
   * Switch one hosted session between asking and `allow-all`. The choice is
   * the user's, made in the view behind a confirmation. The runtime is
   * switched first and the session's mode follows only if it took the change,
   * so what the view shows is what the runtime does. Turning it on also
   * answers what is already waiting.
   */
  async setPermissionMode(sessionId: string, mode: RunPermissionMode): Promise<RunSessionInfo> {
    const hosted = this.require(sessionId);
    const next: RunPermissionMode = mode === 'allow-all' ? 'allow-all' : 'default';
    if (next === 'allow-all') {
      this.requireGate();
    }
    if (hosted.info.permissionMode === next) {
      return { ...hosted.info };
    }
    const taken = await this.deps.driver.setAllowAll(sessionId, next === 'allow-all');
    if (!taken) {
      throw new Error(next === 'allow-all' ? RUN_ALLOW_ALL_REFUSED : RUN_ALLOW_ALL_STUCK);
    }
    hosted.info.permissionMode = next;
    this.note(hosted, 'info', next === 'allow-all' ? RUN_MODE_ALLOW_ALL_NOTE : RUN_MODE_DEFAULT_NOTE);
    if (hosted.pending.length > 0) {
      this.settle(hosted);
    }
    return { ...hosted.info };
  }

  respondInput(requestId: string, answer: string | undefined): void {
    const hosted = [...this.sessions.values()].find((h) => h.input?.requestId === requestId);
    if (hosted === undefined) {
      return;
    }
    hosted.input = undefined;
    this.deps.driver.respondInput(hosted.info.sessionId, requestId, answer);
    this.deps.emit(hosted.info.sessionId, { type: 'input-cleared', requestId });
    this.setStatus(hosted, 'working');
  }

  list(): RunSessionInfo[] {
    return [...this.sessions.values()].map((h) => ({ ...h.info })).sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  }

  transcript(sessionId: string): RunTranscript | undefined {
    const hosted = this.sessions.get(sessionId);
    if (hosted === undefined) {
      return undefined;
    }
    this.flush(hosted);
    return {
      info: { ...hosted.info },
      items: [...hosted.items],
      ...(hosted.pending.length > 0 ? { pendingPermission: shown(hosted.pending) } : {}),
      ...(hosted.input !== undefined ? { pendingInput: hosted.input } : {}),
    };
  }

  /** Exact status for the live board; overrides what the disk tail would infer. */
  liveStates(): RunLiveState[] {
    return [...this.sessions.values()].map((h) => ({
      sessionId: h.info.sessionId,
      status: h.info.status,
      ...(h.info.status === 'waiting-approval'
        ? { waitingFor: 'approval' as const }
        : h.info.status === 'waiting-input'
          ? { waitingFor: 'input' as const }
          : {}),
      lastActivityMs: h.info.lastActivityMs,
      pendingTools: [...new Set([...h.tools.values()].map((t) => t.name))],
    }));
  }

  /** Sessions the app is still hosting, for the quit confirmation. */
  activeCount(): number {
    return [...this.sessions.values()].filter((h) => h.info.status !== 'stopped' && h.info.status !== 'error').length;
  }

  /** The app is closing: answer every parked request as "user not available" and stop. */
  async shutdown(): Promise<void> {
    for (const hosted of this.sessions.values()) {
      this.clearPending(hosted);
      this.cancelFlush(hosted);
    }
    this.sessions.clear();
    await this.deps.driver.dispose();
  }

  // ── internals ──

  private requireGate(): void {
    if (!this.deps.enabled()) {
      throw new Error(REFUSAL_OFF);
    }
    if (!this.deps.acknowledged()) {
      throw new Error(REFUSAL_NOTICE);
    }
  }

  private require(sessionId: string): Hosted {
    const hosted = this.sessions.get(sessionId);
    if (hosted === undefined) {
      throw new Error('This session is not open in the app.');
    }
    return hosted;
  }

  private gateOpen(): boolean {
    return this.deps.enabled() && this.deps.acknowledged();
  }

  private open(
    sessionId: string,
    params: { repository: string; cwd: string; model?: string; door: RunDoor; goal: string },
  ): Hosted {
    const now = this.now();
    const hosted: Hosted = {
      info: {
        sessionId,
        repository: params.repository,
        cwd: params.cwd,
        ...(params.model !== undefined && params.model.length > 0 ? { model: params.model } : {}),
        status: 'starting',
        startedAtMs: now,
        lastActivityMs: now,
        door: params.door,
        // Always the asking mode at first; Allow all is applied through the runtime.
        permissionMode: 'default',
      },
      items: [],
      index: new Map(),
      text: new Map(),
      dirty: new Set(),
      flush: undefined,
      tools: new Map(),
      pending: [],
      granted: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    };
    this.sessions.set(sessionId, hosted);
    this.deps.emit(sessionId, { type: 'status', status: 'starting' });
    return hosted;
  }

  private async connect(hosted: Hosted, how: 'start' | 'resume', model: string | undefined): Promise<void> {
    const options = {
      sessionId: hosted.info.sessionId,
      cwd: hosted.info.cwd,
      ...(model !== undefined && model.length > 0 ? { model } : {}),
      onEvent: (event: DriverEvent) => this.onEvent(hosted, event),
    };
    try {
      await (how === 'start' ? this.deps.driver.start(options) : this.deps.driver.resume(options));
    } catch (err) {
      this.fail(hosted, err);
      this.sessions.delete(hosted.info.sessionId);
      throw err;
    }
  }

  private onEvent(hosted: Hosted, event: DriverEvent): void {
    if (!this.sessions.has(hosted.info.sessionId)) {
      return; // A late event from a session the app already closed.
    }
    hosted.info.lastActivityMs = this.now();
    switch (event.type) {
      case 'delta':
        this.accumulate(hosted, `a:${event.messageId}`, event.text, true);
        break;
      case 'message':
        this.accumulate(hosted, `a:${event.messageId}`, event.text, false);
        this.flush(hosted, new Set([`a:${event.messageId}`]));
        break;
      case 'reasoning-delta':
        this.accumulate(hosted, `r:${event.reasoningId}`, event.text, true);
        break;
      case 'reasoning':
        this.accumulate(hosted, `r:${event.reasoningId}`, event.text, false);
        this.flush(hosted, new Set([`r:${event.reasoningId}`]));
        break;
      case 'tool-start':
        hosted.tools.set(event.toolCallId, { name: event.name, startedAtMs: this.now() });
        this.upsert(hosted, { kind: 'tool', id: `t:${event.toolCallId}`, name: event.name, summary: event.summary ?? '', state: 'running' });
        this.setStatus(hosted, 'working');
        break;
      case 'tool-end': {
        const tool = hosted.tools.get(event.toolCallId);
        hosted.tools.delete(event.toolCallId);
        if (tool !== undefined) {
          this.upsert(hosted, {
            kind: 'tool',
            id: `t:${event.toolCallId}`,
            name: tool.name,
            summary: '',
            state: event.success ? 'ok' : 'failed',
            durationMs: Math.max(0, this.now() - tool.startedAtMs),
          });
        }
        break;
      }
      case 'usage':
        hosted.usage.inputTokens += event.inputTokens;
        hosted.usage.outputTokens += event.outputTokens;
        if (event.nanoAiu !== undefined) {
          hosted.usage.nanoAiu = (hosted.usage.nanoAiu ?? 0) + event.nanoAiu;
        }
        this.deps.emit(hosted.info.sessionId, { type: 'usage', ...hosted.usage });
        break;
      case 'idle':
        this.finishStreaming(hosted);
        hosted.tools.clear();
        this.setStatus(hosted, 'idle');
        this.deps.onTurnEnded?.(hosted.info.sessionId);
        break;
      case 'error':
        this.fail(hosted, new Error(event.message));
        if (event.disconnected === true && hosted.info.permissionMode === 'allow-all') {
          // The mode lived in the CLI that is gone; a reconnect starts asking.
          hosted.info.permissionMode = 'default';
          this.note(hosted, 'info', RUN_MODE_LOST_NOTE);
        }
        break;
      case 'permission': {
        const asked: Asked = {
          request: toRequest(hosted.info.sessionId, event.request),
          ...(event.request.sessionScope !== undefined ? { scope: event.request.sessionScope } : {}),
          mustAsk: event.request.mustAsk,
        };
        if (this.standingApproval(hosted, asked)) {
          this.deps.driver.respondPermission(hosted.info.sessionId, asked.request.requestId, { decision: 'allow-once' });
          break;
        }
        hosted.pending.push(asked);
        this.deps.emit(hosted.info.sessionId, { type: 'permission', request: shown(hosted.pending) });
        this.setStatus(hosted, 'waiting-approval');
        break;
      }
      case 'input':
        hosted.input = {
          requestId: event.requestId,
          sessionId: hosted.info.sessionId,
          question: event.question.slice(0, RUN_PERMISSION_TEXT_MAX),
          ...(event.choices !== undefined ? { choices: event.choices } : {}),
        };
        this.deps.emit(hosted.info.sessionId, { type: 'input', request: hosted.input });
        this.setStatus(hosted, 'waiting-input');
        break;
    }
  }

  /**
   * Whether the user's own standing choice for this session already answers a
   * request: `allow-all`, or an earlier "for this session" whose scope covers
   * it. Never for a request the runtime says must be put to the user, and
   * never while Run is off.
   */
  private standingApproval(hosted: Hosted, asked: Asked): boolean {
    if (asked.mustAsk || !this.gateOpen()) {
      return false;
    }
    if (hosted.info.permissionMode === 'allow-all') {
      return true;
    }
    const scope = asked.scope;
    return (
      scope !== undefined && asked.request.canAllowSession && hosted.granted.some((granted) => scopeCovers(granted, scope))
    );
  }

  /**
   * After an answer or a change of mode: approve what the user's standing
   * choices now cover, then show the next waiting request or go back to work.
   */
  private settle(hosted: Hosted): void {
    const sessionId = hosted.info.sessionId;
    hosted.pending = hosted.pending.filter((asked) => {
      if (!this.standingApproval(hosted, asked)) {
        return true;
      }
      this.deps.driver.respondPermission(sessionId, asked.request.requestId, { decision: 'allow-once' });
      this.deps.emit(sessionId, { type: 'permission-cleared', requestId: asked.request.requestId });
      return false;
    });
    if (hosted.pending.length === 0) {
      this.setStatus(hosted, 'working');
      return;
    }
    this.deps.emit(sessionId, { type: 'permission', request: shown(hosted.pending) });
    this.setStatus(hosted, 'waiting-approval');
  }

  /** Put something on the record, where the user reads what happened. */
  private note(hosted: Hosted, level: 'info' | 'error', text: string): void {
    this.upsert(hosted, { kind: 'notice', id: `n:${this.newId()}`, level, text });
  }

  private accumulate(hosted: Hosted, id: string, text: string, append: boolean): void {
    hosted.text.set(id, append ? (hosted.text.get(id) ?? '') + text : text);
    hosted.dirty.add(id);
    if (hosted.flush === undefined) {
      hosted.flush = this.timers.setTimeout(() => {
        hosted.flush = undefined;
        this.flush(hosted);
      }, this.deps.flushMs ?? RUN_FLUSH_MS);
    }
  }

  /** Push every changed message as WHOLE host-rendered HTML; `done` marks the final ones. */
  private flush(hosted: Hosted, done: ReadonlySet<string> = new Set()): void {
    for (const id of new Set([...hosted.dirty, ...done])) {
      const text = hosted.text.get(id);
      if (text === undefined) {
        continue;
      }
      const previous = hosted.index.get(id);
      const wasDone = previous !== undefined && (hosted.items[previous] as { done?: boolean }).done === true;
      this.upsert(hosted, {
        kind: id.startsWith('r:') ? 'reasoning' : 'assistant',
        id,
        html: this.deps.renderMarkdown(text),
        done: wasDone || done.has(id),
      });
    }
    hosted.dirty.clear();
  }

  private finishStreaming(hosted: Hosted): void {
    this.cancelFlush(hosted);
    this.flush(hosted, new Set(hosted.text.keys()));
    hosted.text.clear();
  }

  private cancelFlush(hosted: Hosted): void {
    if (hosted.flush !== undefined) {
      this.timers.clearTimeout(hosted.flush);
      hosted.flush = undefined;
    }
  }

  private upsert(hosted: Hosted, item: RunItem): void {
    const at = hosted.index.get(item.id);
    if (at === undefined) {
      hosted.index.set(item.id, hosted.items.length);
      hosted.items.push(item);
    } else {
      hosted.items[at] = item;
    }
    this.deps.emit(hosted.info.sessionId, { type: 'item', item });
  }

  private setStatus(hosted: Hosted, status: RunStatus): void {
    if (hosted.info.status === status) {
      return;
    }
    hosted.info.status = status;
    hosted.info.lastActivityMs = this.now();
    this.deps.emit(hosted.info.sessionId, { type: 'status', status });
  }

  private fail(hosted: Hosted, err: unknown): void {
    this.clearPending(hosted);
    this.finishStreaming(hosted);
    this.upsert(hosted, {
      kind: 'notice',
      id: `n:${this.newId()}`,
      level: 'error',
      text: err instanceof Error ? err.message : String(err),
    });
    this.setStatus(hosted, 'error');
  }

  /** Release whatever is parked: the user is no longer going to answer it. */
  private clearPending(hosted: Hosted): void {
    const sessionId = hosted.info.sessionId;
    for (const asked of hosted.pending.splice(0)) {
      this.deps.driver.respondPermission(sessionId, asked.request.requestId, { decision: 'unavailable' });
      this.deps.emit(sessionId, { type: 'permission-cleared', requestId: asked.request.requestId });
    }
    if (hosted.input !== undefined) {
      const requestId = hosted.input.requestId;
      hosted.input = undefined;
      this.deps.driver.respondInput(sessionId, requestId, undefined);
      this.deps.emit(sessionId, { type: 'input-cleared', requestId });
    }
  }
}

/** The request on screen: the oldest one waiting, with how many wait behind it. */
function shown(pending: readonly Asked[]): RunPermissionRequest {
  const { more: _previous, ...head } = pending[0].request;
  return pending.length > 1 ? { ...head, more: pending.length - 1 } : head;
}

/**
 * Models in alphabetical order by the name shown. Compared in lower case, by
 * code unit, so the order is the same on every machine.
 */
export function sortModels(models: readonly { id: string; label: string }[]): { id: string; label: string }[] {
  const key = (model: { id: string; label: string }): string => model.label.toLowerCase();
  return [...models].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** What the user is shown: the exact command or file, capped; the diff only as a line count. */
export function toRequest(sessionId: string, request: DriverPermission): RunPermissionRequest {
  const cap = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : value.slice(0, RUN_PERMISSION_TEXT_MAX);
  const commandText = cap(request.commandText ?? request.url);
  const intention = cap(request.intention);
  return {
    requestId: request.requestId,
    sessionId,
    kind: request.kind,
    ...(request.toolName !== undefined ? { toolName: request.toolName } : {}),
    ...(request.fileName !== undefined ? { fileName: request.fileName } : {}),
    ...(commandText !== undefined ? { commandText } : {}),
    ...(intention !== undefined ? { intention } : {}),
    ...(request.diff !== undefined ? { diffStat: diffStat(request.diff) } : {}),
    canAllowSession: request.canAllowSession,
    ...(request.canAllowSession && request.sessionScope !== undefined
      ? { sessionScopeLabel: scopeLabel(request.sessionScope).slice(0, 200) }
      : {}),
  };
}

export function diffStat(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      added += 1;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      removed += 1;
    }
  }
  return { added, removed };
}
