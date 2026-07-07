/**
 * Typed, raw-preserving client for the GitHub **agent-tasks REST API** and the
 * **CAPI session-logs** endpoint. All networking goes through the shared
 * {@link HttpPoster} seam (so it is unit-testable and never introduces a second
 * transport), with an `Authorization: Bearer <token>` header per account.
 *
 * The preview API drifts (documented fields have gone missing; three SSE shapes
 * in one session), so this layer only fetches + parses envelopes and preserves
 * the raw payloads for the sink — it maps HTTP status to a typed
 * {@link CloudApiResult}, never throwing into the poller. The undocumented CAPI
 * logs endpoint is isolated here (it is exactly what the official `gh` CLI ships
 * on); a 404/shape change degrades to metadata-only.
 */

import type { HttpPoster } from '../sync/httpPoster';
import type { FailureReason } from '../telemetry/telemetryService';
import {
  CloudAccountAuth,
  CloudRepoRef,
  RawCloudTask,
  RawCloudTaskDetail,
} from './cloudTypes';
import { networkMessage, statusFailure } from './ghAuth';

const GITHUB_API_BASE = 'https://api.github.com';
/** Agent-tasks REST API version (probed 2026-07-07). */
const AGENTS_API_VERSION = '2026-03-10';
/** CAPI logs endpoint API version. */
const CAPI_API_VERSION = '2026-01-09';

export type CloudApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: FailureReason; message: string };

export interface CloudApiClientDeps {
  http: HttpPoster;
}

export class CloudApiClient {
  private readonly repoCache = new Map<number, CloudRepoRef>();

  constructor(private readonly deps: CloudApiClientDeps) {}

  /** The authenticated user's own cloud-agent tasks (scope `my-tasks`). */
  async listMyTasks(auth: CloudAccountAuth, maxTasks: number): Promise<CloudApiResult<RawCloudTask[]>> {
    return this.listTasks(auth, `${GITHUB_API_BASE}/agents/tasks?per_page=${clampPer(maxTasks)}`, maxTasks);
  }

  /** A repository's cloud-agent tasks (scope `repos`, Phase 3 — teammates' tasks). */
  async listRepoTasks(
    auth: CloudAccountAuth,
    owner: string,
    repo: string,
    maxTasks: number,
  ): Promise<CloudApiResult<RawCloudTask[]>> {
    const url = `${GITHUB_API_BASE}/agents/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tasks?per_page=${clampPer(maxTasks)}`;
    return this.listTasks(auth, url, maxTasks);
  }

  private async listTasks(
    auth: CloudAccountAuth,
    url: string,
    maxTasks: number,
  ): Promise<CloudApiResult<RawCloudTask[]>> {
    const res = await this.getJson(url, this.restHeaders(auth.token));
    if (!res.ok) {
      return res;
    }
    const parsed = res.value as unknown;
    let tasks: RawCloudTask[];
    if (Array.isArray(parsed)) {
      tasks = parsed as RawCloudTask[];
    } else if (parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { tasks?: unknown }).tasks)) {
      tasks = (parsed as { tasks: RawCloudTask[] }).tasks;
    } else {
      tasks = [];
    }
    // Most-recent first when the API doesn't guarantee order, then cap.
    const sorted = [...tasks].sort((a, b) => taskTimeMs(b) - taskTimeMs(a));
    return { ok: true, value: sorted.slice(0, Math.max(1, maxTasks)) };
  }

  /** Full task detail with nested sessions (`GET agents/tasks/{id}`). */
  async getTaskDetail(auth: CloudAccountAuth, taskId: string): Promise<CloudApiResult<RawCloudTaskDetail>> {
    const res = await this.getJson(`${GITHUB_API_BASE}/agents/tasks/${encodeURIComponent(taskId)}`, this.restHeaders(auth.token));
    if (!res.ok) {
      return res;
    }
    const value = res.value as RawCloudTaskDetail;
    if (value === null || typeof value !== 'object' || typeof value.id !== 'string') {
      return { ok: false, reason: 'error', message: `Malformed task detail for ${taskId}.` };
    }
    return { ok: true, value };
  }

  /** Resolve a bare numeric repository id to `owner/repo` (cached; ids are immutable). */
  async resolveRepo(auth: CloudAccountAuth, repoId: number): Promise<CloudApiResult<CloudRepoRef>> {
    const cached = this.repoCache.get(repoId);
    if (cached !== undefined) {
      return { ok: true, value: cached };
    }
    const res = await this.getJson(`${GITHUB_API_BASE}/repositories/${repoId}`, this.restHeaders(auth.token));
    if (!res.ok) {
      return res;
    }
    const parsed = res.value as { id?: unknown; name?: unknown; owner?: { login?: unknown } };
    const owner = typeof parsed.owner?.login === 'string' ? parsed.owner.login : undefined;
    const name = typeof parsed.name === 'string' ? parsed.name : undefined;
    if (owner === undefined || name === undefined) {
      return { ok: false, reason: 'error', message: `Malformed repository payload for id ${repoId}.` };
    }
    const ref: CloudRepoRef = { id: repoId, owner, name };
    this.repoCache.set(repoId, ref);
    return { ok: true, value: ref };
  }

  /** Seed the in-memory repo cache from the sink's persisted `repos.json`. */
  seedRepoCache(refs: readonly CloudRepoRef[]): void {
    for (const ref of refs) {
      this.repoCache.set(ref.id, ref);
    }
  }

  /** All repo refs resolved so far (for the sink to persist). */
  knownRepos(): CloudRepoRef[] {
    return [...this.repoCache.values()];
  }

  /**
   * Fetch a session's raw CAPI SSE log. Returns the raw body verbatim (the sink
   * stores it immutably for terminal sessions and re-parses on parser upgrade).
   */
  async fetchSessionLog(auth: CloudAccountAuth, sessionId: string): Promise<CloudApiResult<string>> {
    const url = `${auth.capiBase}/agents/sessions/${encodeURIComponent(sessionId)}/logs`;
    let status: number;
    let body: string;
    let header: ((name: string) => string | undefined) | undefined;
    try {
      const res = await this.deps.http.get(url, this.capiHeaders(auth.token));
      status = res.status;
      body = res.body;
      header = res.header;
    } catch (err) {
      return { ok: false, reason: 'network', message: networkMessage(err) };
    }
    const failure = statusFailure(status, header);
    if (failure !== undefined) {
      return failure;
    }
    return { ok: true, value: body };
  }

  /** GET `url` and JSON-parse the body, mapping status/parse errors to failures. */
  private async getJson(url: string, headers: Record<string, string>): Promise<CloudApiResult<unknown>> {
    let status: number;
    let body: string;
    let header: ((name: string) => string | undefined) | undefined;
    try {
      const res = await this.deps.http.get(url, headers);
      status = res.status;
      body = res.body;
      header = res.header;
    } catch (err) {
      return { ok: false, reason: 'network', message: networkMessage(err) };
    }
    const failure = statusFailure(status, header);
    if (failure !== undefined) {
      return failure;
    }
    try {
      return { ok: true, value: JSON.parse(body) };
    } catch {
      return { ok: false, reason: 'error', message: 'GitHub API returned an unparseable JSON body.' };
    }
  }

  private restHeaders(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': AGENTS_API_VERSION,
    };
  }

  private capiHeaders(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      'Copilot-Integration-Id': 'copilot-4-cli',
      'X-GitHub-Api-Version': CAPI_API_VERSION,
    };
  }
}

/** A task's newest timestamp (updated_at ?? created_at) in ms, for ordering. */
function taskTimeMs(task: RawCloudTask): number {
  const t = task.updated_at ?? task.created_at;
  if (typeof t !== 'string') {
    return 0;
  }
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : 0;
}

/** Clamp the `per_page` query param to GitHub's 1..100 range. */
function clampPer(maxTasks: number): number {
  if (!Number.isFinite(maxTasks) || maxTasks <= 0) {
    return 100;
  }
  return Math.min(100, Math.max(1, Math.floor(maxTasks)));
}
