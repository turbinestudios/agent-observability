import * as fs from 'node:fs';
import * as path from 'node:path';
import { applyEdits, findNodeAtLocation, modify, parseTree, printParseErrorCode } from 'jsonc-parser';
import type { ParseError } from 'jsonc-parser';
import { copilotConfigTargets } from '@agent-observability/core/src/telemetry/paths';
import type { CopilotConfigTarget } from '@agent-observability/core/src/telemetry/paths';
import { COPILOT_TRACE_SETTING } from '../shared/rpc';
import type {
  CopilotSetupStatus,
  CopilotSetupTarget,
  CopilotTraceState,
  EnableTracingResult,
  EnableTracingTargetResult,
} from '../shared/rpc';

/**
 * The Copilot tracing setup check and its one-click fix.
 *
 * Copilot Chat writes `agent-traces.db` only while
 * {@link COPILOT_TRACE_SETTING} is true in the editor's `User/settings.json`,
 * and the setting is off by default — so a machine can use Copilot daily and
 * give this app nothing to observe. The check classifies that setting per
 * installed editor; the fix writes `true` into the file.
 *
 * Invariants:
 * - The check is read-only.
 * - The write is a LOCAL file edit, performed only on explicit user action
 *   (the startup prompt's Enable button, or the one in Settings). The only
 *   exception is the opt-in {@link COPILOT_SETUP_AUTO_APPLY_KEY} mode, which
 *   still fixes only 'unset' / 'no-settings-file' targets — a key explicitly
 *   set to `false` is a user decision this app never overrides.
 * - Comments and formatting in settings.json survive: edits go through
 *   jsonc-parser's `modify`/`applyEdits`, the same machinery VS Code uses.
 * - Nothing leaves the machine.
 *
 * Out of scope (v1): non-default VS Code profiles, workspace-level settings,
 * and the `os.tmpdir()/copilot-agent-traces.db` fallback DB (the Settings
 * path override already covers that rare case, and a tmpdir candidate would
 * pollute the "checked locations" list).
 */

/** Settings key persisting the startup prompt dismissal (precedent: `aiHelper.disclosed`). */
export const COPILOT_SETUP_DISMISS_KEY = 'copilotSetup.promptDismissed';
/** Opt-in silent mode: fix 'unset'/'no-settings-file' targets at launch without asking. No UI sets it today. */
export const COPILOT_SETUP_AUTO_APPLY_KEY = 'copilotSetup.autoApply';

/** The subset of the desktop settings store this module reads. */
export interface SetupSettings {
  get<T>(key: string, defaultValue: T): T;
}

/** The subset of core's Configuration this module reads. */
export interface SetupConfig {
  isLocalTelemetryEnabled(): boolean;
}

/** Injectable I/O so tests never touch the developer's real editors. */
export interface CopilotSetupSeams {
  targets?: () => CopilotConfigTarget[];
  /** Reads a file's text; throws NodeJS.ErrnoException on failure. */
  readFile?: (file: string) => string;
  /** Atomic write (temp file + rename), creating parent directories. */
  writeFile?: (file: string, text: string) => void;
}

const FIXABLE_STATES: ReadonlySet<CopilotTraceState> = new Set([
  'unset',
  'disabled',
  'no-settings-file',
]);

/** States the silent auto-apply mode may fix — never an explicit `false`. */
const AUTO_FIXABLE_STATES: ReadonlySet<CopilotTraceState> = new Set(['unset', 'no-settings-file']);

const VARIANT_LABELS: Record<string, string> = {
  Code: 'VS Code',
  'Code - Insiders': 'VS Code Insiders',
};

function defaultReadFile(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

function defaultWriteFile(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A classified target plus the file text, so the write path never reads twice. */
interface ClassifiedTarget {
  target: CopilotSetupTarget;
  /** The settings.json text; '' when the file does not exist yet. */
  text: string;
}

function classify(
  candidate: CopilotConfigTarget,
  readFile: (file: string) => string,
): ClassifiedTarget {
  const base = {
    variant: candidate.variant,
    variantLabel: VARIANT_LABELS[candidate.variant] ?? candidate.variant,
    settingsFile: candidate.settingsFile,
    dbExists: candidate.dbKind === 'file',
  };

  let text: string;
  try {
    text = readFile(candidate.settingsFile);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { target: { ...base, state: 'no-settings-file' }, text: '' };
    }
    return { target: { ...base, state: 'denied', detail: errorText(err) }, text: '' };
  }

  // VS Code's own settings.json rules: comments AND trailing commas allowed.
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: true, allowEmptyContent: true });
  if (errors.length > 0) {
    const detail = `settings.json could not be parsed (${printParseErrorCode(errors[0].error)})`;
    return { target: { ...base, state: 'unparseable', detail }, text };
  }
  if (tree === undefined) {
    // Empty (or whitespace/comment-only) file: same as an absent key.
    return { target: { ...base, state: 'unset' }, text };
  }
  if (tree.type !== 'object') {
    const detail = 'settings.json is not a JSON object';
    return { target: { ...base, state: 'unparseable', detail }, text };
  }

  // Settings keys are flat dotted strings, so the location path has ONE element.
  const node = findNodeAtLocation(tree, [COPILOT_TRACE_SETTING]);
  if (node === undefined) {
    return { target: { ...base, state: 'unset' }, text };
  }
  return { target: { ...base, state: node.value === true ? 'enabled' : 'disabled' }, text };
}

/**
 * Whether the startup prompt belongs on screen. Pure; exported for tests.
 *
 * It fires only when the app has no Copilot data anywhere AND can change
 * that: one editor already tracing (or already holding a DB) makes this a
 * Settings-page matter, not a launch prompt.
 */
export function shouldPromptForSetup(
  targets: CopilotSetupTarget[],
  copilotSourceEnabled: boolean,
  promptDismissed: boolean,
): boolean {
  return (
    copilotSourceEnabled &&
    !promptDismissed &&
    targets.length > 0 &&
    !targets.some((t) => t.state === 'enabled') &&
    !targets.some((t) => t.dbExists) &&
    targets.some((t) => FIXABLE_STATES.has(t.state))
  );
}

/** Read-only per-editor classification of the trace-exporter setting. */
export function checkCopilotSetup(
  settings: SetupSettings,
  config: SetupConfig,
  seams: CopilotSetupSeams = {},
): CopilotSetupStatus {
  const readFile = seams.readFile ?? defaultReadFile;
  const targets = (seams.targets ?? copilotConfigTargets)().map((c) => classify(c, readFile).target);
  const copilotSourceEnabled = config.isLocalTelemetryEnabled();
  const promptDismissed = settings.get(COPILOT_SETUP_DISMISS_KEY, false);
  return {
    targets,
    copilotSourceEnabled,
    promptDismissed,
    shouldPrompt: shouldPromptForSetup(targets, copilotSourceEnabled, promptDismissed),
  };
}

/**
 * The consented write: set {@link COPILOT_TRACE_SETTING} to true in each given
 * settings.json. Error-as-value per file; one failure never stops the others.
 * Requested paths are validated against a fresh target list — this process
 * must never write to an arbitrary renderer-supplied path — and each file is
 * re-classified at write time rather than trusting a stale status.
 */
export function enableCopilotTracing(
  settingsFiles: string[],
  settings: SetupSettings,
  config: SetupConfig,
  seams: CopilotSetupSeams = {},
): EnableTracingResult {
  const readFile = seams.readFile ?? defaultReadFile;
  const writeFile = seams.writeFile ?? defaultWriteFile;
  const known = new Map((seams.targets ?? copilotConfigTargets)().map((t) => [t.settingsFile, t]));

  const results: EnableTracingTargetResult[] = settingsFiles.map((settingsFile) => {
    const candidate = known.get(settingsFile);
    if (candidate === undefined) {
      return { settingsFile, ok: false, detail: 'Not a known editor settings file.' };
    }
    const { target, text } = classify(candidate, readFile);
    if (target.state === 'enabled') {
      return { settingsFile, ok: true, detail: 'Tracing was already switched on.' };
    }
    if (target.state === 'unparseable' || target.state === 'denied') {
      return { settingsFile, ok: false, detail: target.detail ?? 'The file cannot be edited.' };
    }
    try {
      const edits = modify(text, [COPILOT_TRACE_SETTING], true, {
        formattingOptions: { insertSpaces: true, tabSize: 4 },
      });
      writeFile(settingsFile, applyEdits(text, edits));
      return { settingsFile, ok: true, detail: 'Tracing switched on.' };
    } catch (err) {
      return { settingsFile, ok: false, detail: errorText(err) };
    }
  });

  return { results, status: checkCopilotSetup(settings, config, seams) };
}

/**
 * The advisory for the index status bar when no editor is tracing but at
 * least one could be. Empty when there is nothing worth saying.
 */
export function setupNotes(status: CopilotSetupStatus): string[] {
  const actionable =
    status.copilotSourceEnabled &&
    !status.targets.some((t) => t.state === 'enabled') &&
    status.targets.some((t) => FIXABLE_STATES.has(t.state));
  return actionable
    ? ['Copilot: tracing is switched off in VS Code — enable it in Settings']
    : [];
}

/**
 * The launch-time hook. In the default prompt mode it only computes status —
 * the renderer decides whether to show the startup prompt from
 * `status.shouldPrompt`. In the opt-in silent mode it additionally writes the
 * setting for auto-fixable targets. Returns advisory notes for the index
 * status bar; empty when there is nothing worth saying.
 */
export function startupCopilotSetup(
  settings: SetupSettings,
  config: SetupConfig,
  seams: CopilotSetupSeams = {},
): { status: CopilotSetupStatus; notes: string[] } {
  let status = checkCopilotSetup(settings, config, seams);

  if (settings.get(COPILOT_SETUP_AUTO_APPLY_KEY, false) && status.copilotSourceEnabled) {
    const auto = status.targets.filter((t) => AUTO_FIXABLE_STATES.has(t.state));
    if (auto.length > 0) {
      const result = enableCopilotTracing(
        auto.map((t) => t.settingsFile),
        settings,
        config,
        seams,
      );
      status = result.status;
      if (result.results.some((r) => r.ok)) {
        return {
          status,
          notes: ['Copilot: tracing was switched on — restart VS Code to start recording'],
        };
      }
    }
  }

  return { status, notes: setupNotes(status) };
}
