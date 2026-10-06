import type {
  RunAvailability,
  RunDoor,
  RunPermissionDecision,
  RunPermissionMode,
  RunPrefill,
  RunPrefillParams,
  RunRepository,
  RunSessionInfo,
  RunTranscript,
} from '../../shared/rpc';
import type { RunController } from './runController';
import {
  blankPrefill,
  continueSessionPrefill,
  digestPrefill,
  handoffPrefill,
  planPrefill,
  retroPrefill,
} from './runPrefill';

/**
 * The RPC face of Run: everything between the renderer and the controller.
 *
 * Two rules live here rather than in the controller, because they are about
 * what the RENDERER may ask for:
 *
 * 1. **The renderer never supplies a path.** `run.start` takes a repository
 *    and `run.resume` a session id; this layer resolves the working directory
 *    itself, from a checkout whose git remote still matches or from the
 *    session's own record, and refuses when it cannot.
 * 2. **Doors carry ids, not text.** `run.prefill` builds the goal text here,
 *    from data the app already holds, and returns it for the user to read and
 *    edit. Nothing is sent by a prefill.
 *
 * The enabled-and-acknowledged gate is checked here as well as in the
 * controller, so a refusal does not depend on which layer a caller reaches.
 */
export const RUN_REFUSAL_OFF = 'Run is turned off in Settings.';
export const RUN_REFUSAL_NOTICE = 'Read and accept the Run notice first.';
/** Copilot CLI sessions scanned for extra checkouts the index cannot verify by remote. */
export const RUN_CLI_CWD_SCAN = 30;

export interface RunServiceDeps {
  controller: Pick<
    RunController,
    | 'availability'
    | 'start'
    | 'resume'
    | 'send'
    | 'abort'
    | 'close'
    | 'respondPermission'
    | 'setPermissionMode'
    | 'respondInput'
    | 'list'
    | 'transcript'
  >;
  enabled: () => boolean;
  acknowledged: () => boolean;
  /** Records the acknowledgement; the only writer of `run.disclosed`. */
  acknowledge: () => void;
  defaultModel: () => string;
  /** Repositories the index knows, most active first. */
  repositories: () => string[];
  /** A checkout whose remote still resolves to this repository, verified on disk. */
  resolveRoot: (repository: string) => string | undefined;
  /** Recent Copilot CLI sessions as `{ sessionId, repository }`, newest first. */
  cliSessions: () => { sessionId: string; repository: string }[];
  /** The directory a Copilot CLI session ran in, when it still exists. */
  cliCwd: (sessionId: string) => string | undefined;
  isHidden: (source: string, sessionId: string) => boolean;
  repositoryOf: (source: string, sessionId: string) => string | undefined;
  // ── prefill sources: each returns already-local text, never a path ──
  digestMarkdown: (repository: string) => string | undefined;
  plan: (planId: string) => { repository: string; summary?: string; edits: { path: string; action: string; rationale?: string }[] } | undefined;
  retro: (source: string, sessionId: string) => { goal?: string; tips: string[]; findings: string[] } | undefined;
  handoffMarkdown: (source: string, sessionId: string) => string | undefined;
}

export class RunService {
  constructor(private readonly deps: RunServiceDeps) {}

  availability(): Promise<RunAvailability> {
    return this.deps.controller.availability();
  }

  acknowledge(): Promise<RunAvailability> {
    // Acknowledging while Run is off would let a later toggle skip the notice.
    if (!this.deps.enabled()) {
      throw new Error(RUN_REFUSAL_OFF);
    }
    this.deps.acknowledge();
    return this.deps.controller.availability();
  }

  repositories(): RunRepository[] {
    this.gate();
    const found = new Map<string, string>();
    for (const repository of this.deps.repositories()) {
      if (repository === 'unknown' || found.has(repository)) {
        continue;
      }
      const root = this.deps.resolveRoot(repository);
      if (root !== undefined) {
        found.set(repository, root);
      }
    }
    for (const session of this.deps.cliSessions().slice(0, RUN_CLI_CWD_SCAN)) {
      if (session.repository === 'unknown' || found.has(session.repository)) {
        continue;
      }
      const cwd = this.deps.cliCwd(session.sessionId);
      if (cwd !== undefined) {
        found.set(session.repository, cwd);
      }
    }
    return [...found.entries()].map(([repository, cwd]) => ({ repository, cwd }));
  }

  start(params: {
    goal: string;
    repository: string;
    model?: string;
    door: RunDoor;
    permissionMode?: RunPermissionMode;
  }): Promise<RunSessionInfo> {
    this.gate();
    const repository = typeof params?.repository === 'string' ? params.repository : '';
    const goal = typeof params?.goal === 'string' ? params.goal.trim() : '';
    if (goal.length === 0) {
      throw new Error('Write what the session should do first.');
    }
    const cwd = this.cwdFor(repository);
    if (cwd === undefined) {
      throw new Error(
        'No local checkout of this repository could be verified. Run an agent session in it once, or check that the folder still exists and its git remote still matches.',
      );
    }
    const model = cleanModel(params.model) ?? cleanModel(this.deps.defaultModel());
    return this.deps.controller.start({
      goal,
      repository,
      cwd,
      ...(model !== undefined ? { model } : {}),
      door: params.door ?? 'blank',
      // Only the exact word turns it on; anything else is the asking default.
      permissionMode: params.permissionMode === 'allow-all' ? 'allow-all' : 'default',
    });
  }

  resume(sessionId: string): Promise<RunSessionInfo> {
    this.gate();
    if (typeof sessionId !== 'string' || !UUID.test(sessionId)) {
      throw new Error('That is not a session this app can continue.');
    }
    const cwd = this.deps.cliCwd(sessionId);
    if (cwd === undefined) {
      throw new Error('The folder this session ran in is no longer there, so it cannot be continued here.');
    }
    const model = cleanModel(this.deps.defaultModel());
    return this.deps.controller.resume({
      sessionId,
      repository: this.deps.repositoryOf('copilot-cli', sessionId) ?? 'unknown',
      cwd,
      ...(model !== undefined ? { model } : {}),
    });
  }

  send(sessionId: string, text: string): Promise<void> {
    this.gate();
    return this.deps.controller.send(sessionId, text);
  }

  /** Stopping, closing and denying always work, so nothing can be stranded. */
  abort(sessionId: string): Promise<void> {
    return this.deps.controller.abort(sessionId);
  }

  close(sessionId: string): Promise<void> {
    return this.deps.controller.close(sessionId);
  }

  respondPermission(requestId: string, decision: RunPermissionDecision, feedback?: string): void {
    // An approval is an action; a denial is always allowed.
    if (decision !== 'deny') {
      this.gate();
    }
    this.deps.controller.respondPermission(requestId, decision, feedback);
  }

  /** Going back to asking is always allowed; turning Allow all on is an action. */
  setPermissionMode(sessionId: string, mode: RunPermissionMode): Promise<RunSessionInfo> {
    if (mode === 'allow-all') {
      this.gate();
    }
    return this.deps.controller.setPermissionMode(sessionId, mode === 'allow-all' ? 'allow-all' : 'default');
  }

  respondInput(requestId: string, answer?: string): void {
    if (answer !== undefined) {
      this.gate();
    }
    this.deps.controller.respondInput(requestId, answer);
  }

  list(): RunSessionInfo[] {
    return this.deps.enabled() ? this.deps.controller.list() : [];
  }

  transcript(sessionId: string): RunTranscript | undefined {
    return this.deps.enabled() ? this.deps.controller.transcript(sessionId) : undefined;
  }

  /** Goal text for a door. Built here; a hidden session contributes nothing. */
  prefill(params: RunPrefillParams): RunPrefill {
    this.gate();
    const { door, source, sessionId, repository, planId } = params ?? { door: 'blank' as RunDoor };
    const hidden = source !== undefined && sessionId !== undefined && this.deps.isHidden(source, sessionId);
    const sessionRepo =
      source !== undefined && sessionId !== undefined && !hidden ? this.deps.repositoryOf(source, sessionId) : undefined;
    switch (door) {
      case 'continue-session':
        return sessionId !== undefined && !hidden && source === 'copilot-cli'
          ? continueSessionPrefill(sessionId, sessionRepo)
          : blankPrefill(repository);
      case 'repo-digest': {
        const markdown = repository !== undefined ? this.deps.digestMarkdown(repository) : undefined;
        return repository !== undefined && markdown !== undefined ? digestPrefill(repository, markdown) : blankPrefill(repository);
      }
      case 'improve-plan': {
        const plan = planId !== undefined ? this.deps.plan(planId) : undefined;
        return plan !== undefined ? planPrefill(plan.repository, plan.summary, plan.edits) : blankPrefill(repository);
      }
      case 'retro-advice': {
        const retro = source !== undefined && sessionId !== undefined && !hidden ? this.deps.retro(source, sessionId) : undefined;
        return retro !== undefined ? retroPrefill(sessionRepo, retro.goal, retro.tips, retro.findings) : blankPrefill(repository);
      }
      case 'handoff-brief': {
        const markdown =
          source !== undefined && sessionId !== undefined && !hidden ? this.deps.handoffMarkdown(source, sessionId) : undefined;
        if (markdown !== undefined) {
          return handoffPrefill(sessionRepo, markdown);
        }
        // The brief is unavailable: fall back to what the retrospective knows.
        const retro = source !== undefined && sessionId !== undefined && !hidden ? this.deps.retro(source, sessionId) : undefined;
        return retro !== undefined ? retroPrefill(sessionRepo, retro.goal, retro.tips, retro.findings) : blankPrefill(repository);
      }
      default:
        return blankPrefill(repository);
    }
  }

  private cwdFor(repository: string): string | undefined {
    if (repository.length === 0 || repository === 'unknown') {
      return undefined;
    }
    return this.repositories().find((entry) => entry.repository === repository)?.cwd;
  }

  private gate(): void {
    if (!this.deps.enabled()) {
      throw new Error(RUN_REFUSAL_OFF);
    }
    if (!this.deps.acknowledged()) {
      throw new Error(RUN_REFUSAL_NOTICE);
    }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A model id safe to hand to the CLI, or undefined for its own default. */
function cleanModel(model: string | undefined): string | undefined {
  const value = typeof model === 'string' ? model.trim() : '';
  return value.length > 0 && /^[A-Za-z0-9._:-]+$/.test(value) ? value : undefined;
}
