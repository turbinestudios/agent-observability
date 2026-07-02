import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { CONFIG_SECTION, ConfigKeys, Configuration } from '../../config/configuration';
import { TelemetryService } from '../../telemetry/telemetryService';
import { OverviewMetrics } from '../../telemetry/models';
import { Conversation, assembleMessages } from '../conversation';
import { ContextLoader } from '../contextLoader';
import { getQuickCommand, selectContextForFreeText } from '../quickCommands';
import { isCancellation } from '../lmErrors';
import { ChatBackend, ChatBackendRegistry } from '../backends/chatBackend';
import { CopilotBackend } from '../backends/copilotBackend';
import { ClaudeCodeBackend } from '../backends/claudeCodeBackend';
import { buildUiState, BackendOption } from '../backends/uiState';
import { renderChatHtml } from './chatViewHtml';
import { markdownToHtml } from './markdownToHtml';
import { HostToWebview, PreferenceKey, WebviewToHost } from './protocol';
import {
  buildWorkflowGenPreamble,
  mergeWorkflowsByRepository,
  validateWorkflowsJson,
} from '../tasks/workflowGen';
import {
  buildContextFilesDigest,
  gatherProjectContextFiles,
  resolveWorkspaceRepository,
} from '../tasks/projectContext';
import { buildMinimalConfigPreamble, parseConfigObject } from '../tasks/minimalConfig';
import { SummaryInput, buildLogSummaryPreamble, buildSummaryDigest, toSafeSessionRow } from '../tasks/logSummary';

/** Contributed view id for the AI Helper webview (matches package.json). */
export const ASSISTANT_VIEW_ID = 'agentObservability.assistant';

/** globalState key recording that the one-time AI Helper disclosure was accepted. */
const DISCLOSURE_KEY = 'agentObservability.aiHelper.disclosed';

/** How many sessions to ground the log-summary task on (token budget). */
const SUMMARY_SESSION_LIMIT = 50;

/** Throttle for re-rendering the streaming assistant bubble. */
const RENDER_THROTTLE_MS = 60;

/**
 * The AI Helper webview view.
 *
 * Bridges the webview UI to the user's GitHub Copilot model (`vscode.lm`),
 * grounded in baked-in context files and the user's LOCAL telemetry. All testable
 * logic lives in the pure seams (`conversation`, `quickCommands`, `tasks/*`,
 * `markdownToHtml`, `lmErrors`); this class is the `vscode`-bound orchestrator,
 * exercised manually in the Extension Host.
 *
 * Privacy: only SAFE metadata leaves the machine (sanitized repositories,
 * agent/model/tool names, durations, token counts) plus the user's prompt — never
 * raw prompt/response content, tool I/O, file contents, or session titles. A
 * one-time disclosure gates the first use, distinct from the cloud-sync consent.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private readonly conversation = new Conversation();
  private readonly contextLoader: ContextLoader;
  private readonly backends: ChatBackendRegistry;
  private cts: vscode.CancellationTokenSource | undefined;
  private busy = false;
  private messageCounter = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly telemetry: TelemetryService,
    private readonly config: Configuration,
  ) {
    this.contextLoader = new ContextLoader(context.extensionUri);
    this.backends = new ChatBackendRegistry([new CopilotBackend(config), new ClaudeCodeBackend(config)]);
    context.subscriptions.push(config.onDidChange(() => void this.postUiState()));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = renderChatHtml(makeNonce());
    view.webview.onDidReceiveMessage((raw: unknown) => {
      void this.onMessage(raw);
    });
    view.onDidDispose(() => {
      this.cancel();
      this.view = undefined;
    });
  }

  /** "New chat" — cancel any in-flight request and clear the transcript. */
  newChat(): void {
    this.cancel();
    this.conversation.clear();
    this.busy = false;
    this.post({ type: 'reset' });
    this.post({ type: 'busy', busy: false });
  }

  /** Cancel an in-flight model request, if any. */
  private cancel(): void {
    this.cts?.cancel();
  }

  private async onMessage(raw: unknown): Promise<void> {
    const msg = raw as WebviewToHost | undefined;
    if (typeof msg?.type !== 'string') {
      return;
    }
    switch (msg.type) {
      case 'send':
        await this.handleTurn(msg.text, undefined);
        return;
      case 'runQuickCommand': {
        const qc = getQuickCommand(msg.id);
        if (qc) {
          await this.handleTurn(qc.prompt, qc.id);
        }
        return;
      }
      case 'stop':
        this.cancel();
        return;
      case 'copy':
        await vscode.env.clipboard.writeText(msg.text);
        vscode.window.setStatusBarMessage('Agent Observability: copied to clipboard.', 2000);
        return;
      case 'applyConfig':
        await this.handleApply(msg.kind, msg.code);
        return;
      case 'setPreference':
        await this.handleSetPreference(msg.key, msg.value);
        return;
      case 'ready':
        void this.postUiState();
        return;
    }
  }

  /** Persist a selector-row change; the config-change listener reposts the UI state. */
  private async handleSetPreference(key: PreferenceKey, value: string): Promise<void> {
    const suffix =
      key === 'backend'
        ? ConfigKeys.aiHelperBackend
        : key === 'effort'
          ? ConfigKeys.aiHelperClaudeEffort
          : this.config.getAiHelperBackend() === 'claude-code'
            ? ConfigKeys.aiHelperClaudeModel
            : ConfigKeys.aiHelperCopilotModel;
    await vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .update(suffix, value, vscode.ConfigurationTarget.Global);
  }

  /** Gather backend availability + models and push the selector-row state. */
  private async postUiState(): Promise<void> {
    if (!this.view) {
      return;
    }
    const activeBackend = this.config.getAiHelperBackend();
    const backendOptions: BackendOption[] = await Promise.all(
      this.backends.all().map(async (backend) => {
        const availability = await backend.isAvailable();
        return {
          id: backend.id,
          label: backend.label,
          available: availability.available,
          hint: availability.available ? undefined : availability.reason,
        };
      }),
    );
    const active = this.backends.get(activeBackend);
    const models = active ? await active.listModels() : [];
    const state = buildUiState({
      backends: backendOptions,
      activeBackend,
      models,
      activeModel:
        activeBackend === 'claude-code'
          ? this.config.getAiHelperClaudeModel()
          : this.config.getAiHelperCopilotModel(),
      activeEffort: this.config.getAiHelperClaudeEffort(),
    });
    this.post({ type: 'uiState', state });
  }

  /** Run one user turn: gather context + telemetry, stream the model response. */
  private async handleTurn(userText: string, commandId: string | undefined): Promise<void> {
    if (this.busy || userText.trim().length === 0) {
      return;
    }
    const backend = this.backends.get(this.config.getAiHelperBackend());
    if (!backend) {
      return; // registry always carries both ids; guards a corrupted setting
    }
    if (!(await this.ensureDisclosed(backend))) {
      return;
    }

    this.setBusy(true);
    this.post({ type: 'userEcho', text: userText });

    const id = `m${this.messageCounter++}`;
    let acc = '';
    let started = false;
    try {
      const availability = await backend.isAvailable();
      if (!availability.available) {
        this.post({ type: 'error', message: availability.reason });
        return;
      }

      this.telemetry.refresh();
      const preamble = await this.buildPreamble(userText, commandId);
      this.conversation.append('user', userText);
      const messages = assembleMessages(preamble, this.conversation.history);

      this.post({ type: 'assistantStart', id });
      started = true;
      this.cts = new vscode.CancellationTokenSource();

      let lastRender = 0;
      const render = (): void => {
        this.post({ type: 'assistantHtml', id, html: markdownToHtml(acc) });
      };
      await backend.streamChat(
        { messages },
        (delta) => {
          acc += delta;
          const now = Date.now();
          if (now - lastRender > RENDER_THROTTLE_MS) {
            lastRender = now;
            render();
          }
        },
        this.cts.token,
      );

      render();
      this.conversation.append('assistant', acc);
      this.post({ type: 'assistantDone', id });
    } catch (err) {
      if (isCancellation(err)) {
        // Keep whatever streamed before the stop; finalize the bubble.
        if (started) {
          this.post({ type: 'assistantHtml', id, html: markdownToHtml(acc) });
          this.conversation.append('assistant', acc);
          this.post({ type: 'assistantDone', id });
        }
      } else {
        this.post({ type: 'error', message: backend.describeError(err).message });
      }
    } finally {
      this.cts?.dispose();
      this.cts = undefined;
      this.setBusy(false);
    }
  }

  /** Build the grounding preamble for a turn (quick command or free text). */
  private async buildPreamble(userText: string, commandId: string | undefined): Promise<string> {
    const names = commandId
      ? getQuickCommand(commandId)?.contextFiles ?? []
      : selectContextForFreeText(userText);
    const contextText = await this.contextLoader.loadMany(names);

    if (commandId === 'generate-workflows') {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const repository = resolveWorkspaceRepository(cwd);
      const files = gatherProjectContextFiles(cwd);
      return buildWorkflowGenPreamble(contextText, buildContextFilesDigest(repository, files));
    }
    if (commandId === 'minimal-config') {
      return buildMinimalConfigPreamble(contextText);
    }
    if (commandId === 'summarize-logs') {
      return buildLogSummaryPreamble(contextText, buildSummaryDigest(this.gatherSummaryInput()));
    }
    return (
      contextText +
      '\n\n## Task\nAnswer the user’s question about the Agent Observability extension and their local ' +
      'telemetry using only the context above. If they ask for configuration, emit a single fenced ' +
      '`ao-config` (settings object) or `ao-workflows` (workflows array) block.'
    );
  }

  /** Gather safe overview + recent sessions + repositories for the summary task. */
  private gatherSummaryInput(): SummaryInput {
    const overviewResult = this.telemetry.getOverview();
    const overview = overviewResult.ok ? overviewResult.value : EMPTY_OVERVIEW;
    const sessionsResult = this.telemetry.listSessions(undefined, SUMMARY_SESSION_LIMIT);
    const sessions = (sessionsResult.ok ? sessionsResult.value : []).map(toSafeSessionRow);
    const reposResult = this.telemetry.listRepositories();
    const repositories = reposResult.ok ? reposResult.value : [];
    return { overview, sessions, repositories };
  }

  /** Validate + confirm + merge a generated config into workspace settings. */
  private async handleApply(kind: 'workflows' | 'config', code: string): Promise<void> {
    if (vscode.workspace.workspaceFolders === undefined) {
      this.post({ type: 'applied', ok: false, message: 'Open a folder or workspace to apply settings.' });
      return;
    }

    if (kind === 'workflows') {
      const validation = validateWorkflowsJson(code, this.config.getMaxSessionMinutes() * 60_000);
      if (!validation.ok) {
        this.post({ type: 'applied', ok: false, message: `Could not apply — ${validation.reason}` });
        return;
      }
      if (!(await confirmApply('Apply the generated workflows to this workspace’s .vscode/settings.json?'))) {
        return;
      }
      const cfg = vscode.workspace.getConfiguration('agentObservability');
      const merged = mergeWorkflowsByRepository(cfg.get('workflows'), validation.value);
      await cfg.update('workflows', merged, vscode.ConfigurationTarget.Workspace);
      this.post({ type: 'applied', ok: true, message: 'Applied workflows to workspace settings.' });
      return;
    }

    const extraction = parseConfigObject(code);
    if (!extraction.ok) {
      this.post({ type: 'applied', ok: false, message: `Could not apply — ${extraction.reason}` });
      return;
    }
    const keys = Object.keys(extraction.settings);
    if (keys.length === 0) {
      this.post({ type: 'applied', ok: false, message: 'No applicable agentObservability settings were found.' });
      return;
    }
    if (!(await confirmApply('Apply these settings to this workspace’s .vscode/settings.json?'))) {
      return;
    }
    const cfg = vscode.workspace.getConfiguration();
    for (const key of keys) {
      await cfg.update(key, extraction.settings[key], vscode.ConfigurationTarget.Workspace);
    }
    let message = `Applied ${keys.length} setting(s) to workspace settings.`;
    if (extraction.dropped.length > 0) {
      message += ` Ignored unknown key(s): ${extraction.dropped.join(', ')}.`;
    }
    this.post({ type: 'applied', ok: true, message });
  }

  /**
   * One-time, per-backend disclosure before the first AI Helper request through
   * that backend — the data goes to a different company per backend. A distinct
   * gate from the cloud-sync consent and from VS Code's own per-extension LM
   * consent prompt. The Copilot key predates backend selection, so users who
   * already consented are not re-prompted.
   */
  private async ensureDisclosed(backend: ChatBackend): Promise<boolean> {
    const key = backend.id === 'copilot' ? DISCLOSURE_KEY : `${DISCLOSURE_KEY}.${backend.id}`;
    if (this.context.globalState.get<boolean>(key, false)) {
      return true;
    }
    const detail =
      backend.id === 'copilot'
        ? 'The AI Helper sends your message and a summary of your local telemetry — repository names, ' +
          'agent/model/tool names, durations, and token counts — to GitHub Copilot under your own ' +
          'license. The “Generate workflows” command additionally reads your project’s Copilot ' +
          'customization files (instructions, agents, prompts, skills) and sends their contents. Raw ' +
          'prompts, completions, tool input/output, and session titles are never sent, and nothing here ' +
          'uses the cloud-sync path, which stays off.'
        : 'The AI Helper sends your message and a summary of your local telemetry — repository names, ' +
          'agent/model/tool names, durations, and token counts — to Anthropic via the Claude Code CLI, ' +
          'under your own Claude login. The “Generate workflows” command additionally reads your ' +
          'project’s Copilot customization files (instructions, agents, prompts, skills) and sends their ' +
          'contents. The CLI runs locally with all tools disabled and writes no session files. Raw ' +
          'prompts, completions, tool input/output, and session titles are never sent, and nothing here ' +
          'uses the cloud-sync path, which stays off.';
    const choice = await vscode.window.showInformationMessage(
      `Use the AI Helper with ${backend.label}?`,
      { modal: true, detail },
      'Continue',
    );
    if (choice === 'Continue') {
      await this.context.globalState.update(key, true);
      return true;
    }
    return false;
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.post({ type: 'busy', busy });
  }

  private post(message: HostToWebview): void {
    void this.view?.webview.postMessage(message);
  }
}

/** Confirm a settings write behind a modal. */
async function confirmApply(message: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    message,
    { modal: true, detail: 'This updates your workspace .vscode/settings.json.' },
    'Apply',
  );
  return choice === 'Apply';
}

/** Per-render CSP nonce, CSPRNG-backed (matches the session-detail panel). */
function makeNonce(): string {
  return crypto.randomBytes(16).toString('base64url');
}

/** Zeroed overview used when telemetry can't be read. */
const EMPTY_OVERVIEW: OverviewMetrics = {
  totalInteractions: 0,
  totalSessions: 0,
  totalRepositories: 0,
  totalModels: 0,
  avgDurationMs: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  errorCount: 0,
};
