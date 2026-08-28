import type { Configuration } from '@agent-observability/core/src/config/configuration';
import type { SourceRegistry } from '@agent-observability/core/src/sources/sessionSource';
import type { CancellationToken } from '@agent-observability/core/src/chat/backends/cancellation';
import type { ChatBackend } from '@agent-observability/core/src/chat/backends/chatBackend';
import { ClaudeCliError } from '@agent-observability/core/src/chat/backends/claudeErrors';
import {
  buildDeepRetrospectivePrompt,
  parseDeepRetrospective,
} from '@agent-observability/core/src/chat/tasks/deepRetrospective';
import type { DeepRetroResult } from '../shared/rpc';
import { sessionKey } from '../shared/rpc';
import { retrospectiveFor } from './analysis/sessionRetrospective';
import { timeoutToken } from './cancellation';
import type { DeepRetroStore } from './deepRetros';
import type { DesktopSettingsReader } from './drivers/desktopConfig';

/**
 * The Deep Retrospective runner — one of the two sanctioned places this app
 * sends session content to a model (the other is the AI Helper, `aiHelper.ts`);
 * see the privacy invariant in AGENTS.md.
 *
 * Consent is enforced in depth: the renderer shows a per-invocation
 * confirmation before calling `retro.deep`, and this module INDEPENDENTLY
 * refuses when the settings toggle is off, so no renderer bug can turn an
 * unconsented call into a network transmission. The spawn is the user's own
 * `claude` CLI (their login, no API key) with tools disabled, one turn, and
 * `--no-session-persistence` — without that last flag the app would ingest its
 * own analysis runs as new sessions.
 */

/** Settings key for the opt-in gate. Desktop-only; not a core ConfigKey. */
export const DEEP_RETRO_ENABLED_KEY = 'retrospective.deepEnabled';

/** One model call may take a while, but not forever. */
const DEEP_RETRO_TIMEOUT_MS = 120_000;

export interface DeepRetroDeps {
  sources: SourceRegistry;
  store: DeepRetroStore;
  config: Configuration;
  settings: DesktopSettingsReader;
  /** The shared chat backend (desktop hints, shared probe cache) — see `aiBackends.ts`. */
  backend: ChatBackend;
  /** Injectable spawn seam so tests never run the real CLI. */
  runPrompt?: (prompt: string, token: CancellationToken) => Promise<string>;
}

/** In-flight runs by session key: a double-click must not start two spawns. */
const inFlight = new Map<string, Promise<DeepRetroResult>>();

export function runDeepRetrospective(
  source: string,
  sessionId: string,
  deps: DeepRetroDeps,
): Promise<DeepRetroResult> {
  const key = sessionKey(source, sessionId);
  const running = inFlight.get(key);
  if (running !== undefined) {
    return running;
  }
  const run = execute(source, sessionId, deps).finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

async function execute(source: string, sessionId: string, deps: DeepRetroDeps): Promise<DeepRetroResult> {
  if (deps.settings.get<boolean>(DEEP_RETRO_ENABLED_KEY, false) !== true) {
    return { error: 'The deep retrospective is turned off in Settings.' };
  }
  const dataSource = deps.sources.get(source);
  if (dataSource === undefined) {
    return { error: `Unknown source: ${source}` };
  }
  const detail = dataSource.getSessionDetail(sessionId);
  if (!detail.ok) {
    return { error: detail.message };
  }

  const heuristic = retrospectiveFor(dataSource, sessionId, detail.value);
  const prompt = buildDeepRetrospectivePrompt(detail.value, heuristic);

  const timeout = timeoutToken(DEEP_RETRO_TIMEOUT_MS);
  try {
    const reply = await (deps.runPrompt ?? cliRunner(deps.backend))(prompt, timeout.token);
    const verdict = parseDeepRetrospective(reply, deps.config.getAiHelperClaudeModel(), Date.now());
    if (verdict === undefined) {
      return { error: 'The model did not return a readable retrospective. Try again.' };
    }
    deps.store.set(source, sessionId, verdict);
    return { verdict };
  } catch (err) {
    if (timeout.token.isCancellationRequested) {
      return { error: 'The deep retrospective timed out.' };
    }
    // CLI failures go through the backend's friendly mapping (which carries the
    // desktop's own "where to fix it" hint); everything else surfaces as-is.
    if (err instanceof ClaudeCliError) {
      return { error: deps.backend.describeError(err).message };
    }
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    timeout.dispose();
  }
}

/** Collect one full CLI reply through the shared chat backend. */
function cliRunner(backend: ChatBackend): (prompt: string, token: CancellationToken) => Promise<string> {
  return async (prompt, token) => {
    const availability = await backend.isAvailable();
    if (!availability.available) {
      throw new Error(availability.reason);
    }
    let collected = '';
    await backend.streamChat(
      { messages: [{ role: 'user', text: prompt }] },
      (delta) => {
        collected += delta;
      },
      token,
    );
    return collected;
  };
}
