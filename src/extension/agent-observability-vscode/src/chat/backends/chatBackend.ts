import type * as vscode from 'vscode';
import type { AssembledMessage } from '../conversation';
import type { FriendlyError } from '../lmErrors';

/**
 * The pluggable inference seam for the AI Helper, mirroring the
 * `SessionDataSource`/`SourceRegistry` pattern in `src/sources/sessionSource.ts`:
 * a new backend is one class, not a provider rewrite. `ChatViewProvider` talks
 * only to this contract; which backend answers is a user setting.
 *
 * Type-only `vscode` import so this module stays loadable under vitest.
 */

/** Stable backend identifier (mirrors the `aiHelper.backend` setting values). */
export type BackendId = 'copilot' | 'claude-code';

/** One selectable model for the active backend. */
export interface ModelChoice {
  id: string;
  label: string;
}

/** Whether a backend can currently serve requests, with a user-facing reason when not. */
export type BackendAvailability = { available: true } | { available: false; reason: string };

/** One chat request: the fully assembled transcript (preamble-first). */
export interface ChatRequest {
  messages: readonly AssembledMessage[];
}

/** A chat inference backend for the AI Helper. */
export interface ChatBackend {
  readonly id: BackendId;
  readonly label: string;
  isAvailable(): Promise<BackendAvailability>;
  listModels(): Promise<ModelChoice[]>;
  /** Stream one response; throws on failure (cancellation included — see `isCancellation`). */
  streamChat(
    request: ChatRequest,
    onDelta: (text: string) => void,
    token: vscode.CancellationToken,
  ): Promise<void>;
  /** Map an error thrown by `streamChat` to a friendly message. */
  describeError(err: unknown): FriendlyError;
}

/** Registry of the available backends in display order (mirrors `SourceRegistry`). */
export class ChatBackendRegistry {
  private readonly byId = new Map<BackendId, ChatBackend>();
  private readonly ordered: ChatBackend[] = [];

  constructor(backends: ChatBackend[]) {
    for (const backend of backends) {
      this.byId.set(backend.id, backend);
      this.ordered.push(backend);
    }
  }

  /** All registered backends, in display order. */
  all(): readonly ChatBackend[] {
    return this.ordered;
  }

  /** Resolve a backend by id, or `undefined`. */
  get(id: string): ChatBackend | undefined {
    return this.byId.get(id as BackendId);
  }
}
