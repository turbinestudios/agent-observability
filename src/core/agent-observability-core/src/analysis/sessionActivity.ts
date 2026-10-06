/**
 * What a session DID, as opposed to what it said: the commands it ran, the
 * files it edited and read, the sub-agents it spawned.
 *
 * This is the one contract every evidence feature reads — the completion
 * check, rework, the review packet, the hand-off brief — so there is exactly
 * one place where command text and edit inputs are pulled out of a transcript
 * (`claude/activitySignals.ts` for Claude Code) and one set of rules for
 * classifying them (this file).
 *
 * Privacy: {@link ActivityCommand.text}, the edit and read paths, and
 * {@link SessionActivity.closingText} are RAW session content. They exist in
 * memory so they can be classified. They must never be persisted, never
 * logged, never placed on the aggregate / sync / team paths, and never emitted
 * to the user without passing the redaction pass. What may be persisted is the
 * class, the counts and the booleans.
 *
 * Pure: no `node:` imports, so the renderer can import the types and tables.
 */

export type CommandClass =
  | 'test'
  | 'build'
  | 'lint'
  | 'typecheck'
  | 'install'
  | 'git'
  | 'run'
  | 'network'
  | 'filesystem'
  | 'other';

/** The classes that count as checking the work. */
export type VerificationClass = 'test' | 'build' | 'lint' | 'typecheck';

/** Most verifying first: a compound command takes the strongest class it contains. */
export const VERIFICATION_CLASSES: readonly VerificationClass[] = ['test', 'typecheck', 'lint', 'build'];

export function isVerificationClass(value: CommandClass): value is VerificationClass {
  return (VERIFICATION_CLASSES as readonly string[]).includes(value);
}

/** One shell command the session ran. */
export interface ActivityCommand {
  /**
   * Position of the tool call in the session, shared across commands, edits
   * and reads, so "did a check run AFTER the last edit" can be answered inside
   * one turn. A side-chain command carries the position of the sub-agent call
   * that spawned it (-1 when that cannot be told).
   */
  order: number;
  /** Index of the user turn the command ran in (-1 before the first prompt). */
  turnIndex: number;
  class: CommandClass;
  /** The tool call reported an error. Meaningless unless {@link resultKnown}. */
  failed: boolean;
  /** A result record was found for the call. */
  resultKnown: boolean;
  /**
   * The command's own exit status cannot be trusted from the tool result: it
   * was piped, followed by `||`, or followed by another command after `;`.
   */
  resultMasked: boolean;
  /** Started with `run_in_background`; its result is not the command's outcome. */
  background: boolean;
  /** Ran inside a sub-agent side-chain rather than on the main thread. */
  sideChain: boolean;
  /** How the exit status is masked, when {@link resultMasked}. */
  maskedBy?: MaskForm;
  /**
   * What is known about the command's own result. Set by the chokepoint for
   * verification commands: from the tool call's error flag when that flag is
   * the command's exit status, else from what the check itself printed. Read
   * it through {@link commandOutcome}, which also covers commands built
   * without it.
   */
  outcome?: VerificationOutcome;
  /** RAW command text. Never persist, never emit unredacted. */
  text: string;
}

/** A check's result as far as the session recorded it. */
export type VerificationOutcome = 'passed' | 'failed' | 'unknown';

/**
 * Why a command's exit status is not the tool call's error flag.
 * - `truncate`: piped to something that only shortens or copies the output
 *   (`tail`, `head`, `tee`, `cat`), so the check's summary usually survives.
 * - `filter`: piped to something that selects lines (`grep`, `findstr`,
 *   `Select-String`, `awk`, `sed`, `wc`…), so an empty result proves nothing.
 * - `pipe`: piped to anything else.
 * - `or`: followed by `||`. `sequence`: followed by `;` and another command.
 */
export type MaskForm = 'truncate' | 'filter' | 'pipe' | 'or' | 'sequence';

/**
 * The command's result: its recorded {@link ActivityCommand.outcome}, or, for
 * a command built without one, the tool call's flag when that flag can be
 * trusted (a result exists, not masked, not a background start).
 */
export function commandOutcome(command: ActivityCommand): VerificationOutcome {
  if (command.outcome !== undefined) {
    return command.outcome;
  }
  if (!command.resultKnown || command.resultMasked || command.background) {
    return 'unknown';
  }
  return command.failed ? 'failed' : 'passed';
}

/** One edit-tool call. */
export interface ActivityFileEdit {
  /** Position of the tool call in the session; see {@link ActivityCommand.order}. */
  order: number;
  turnIndex: number;
  /** Path exactly as the tool input gave it (usually absolute). RAW, local-only. */
  path: string;
  linesAdded: number;
  linesRemoved: number;
  /** Best effort: a `Write` to a path the session had not read or edited before. */
  created: boolean;
  /** The tool that made the edit, e.g. `Edit`, `Write`, `MultiEdit`. */
  tool: string;
}

export interface ActivityFileRead {
  order: number;
  turnIndex: number;
  path: string;
}

export interface SessionActivity {
  commands: ActivityCommand[];
  edits: ActivityFileEdit[];
  reads: ActivityFileRead[];
  /** Distinct permission modes seen, e.g. `plan`, `acceptEdits`, `bypassPermissions`. */
  permissionModes: string[];
  subAgents: { name: string; calls: number }[];
  /** RAW: the tail of the last main-thread assistant text. Classify, never store. */
  closingText?: string;
  /** The last main-thread tool call reported an error and nothing followed it. */
  endedOnFailedTool: boolean;
  /** How many consecutive failed tool calls the session ended on. */
  trailingFailedTools: number;
  /** False when the source cannot see tool inputs (commands and paths are missing). */
  complete: boolean;
  /**
   * Per file (path as recorded): lines an earlier turn added that a later turn
   * removed again. Integers only: the line text the count was matched on never
   * leaves the extraction function. Absent when nothing was reworked.
   */
  reworkedLinesByFile?: Record<string, number>;
}

/** An activity with nothing in it, for sources that carry no tool inputs. */
export function emptyActivity(complete: boolean): SessionActivity {
  return {
    commands: [],
    edits: [],
    reads: [],
    permissionModes: [],
    subAgents: [],
    endedOnFailedTool: false,
    trailingFailedTools: 0,
    complete,
  };
}

// ── Command classification ──────────────────────────────────────────────────

const PM = '(?:npm|pnpm|yarn|bun)';
const JVM = '(?:mvn|mvnw|\\./mvnw|gradle|gradlew|\\./gradlew)';

/**
 * One rule per recognisable command shape, matched against a single segment
 * of a command line after wrappers are stripped. Order matters inside a
 * class group only for readability; the class of a compound command is
 * decided by {@link VERIFICATION_CLASSES}, not by rule order.
 */
export const COMMAND_CLASS_RULES: readonly { class: CommandClass; pattern: RegExp }[] = [
  { class: 'test', pattern: new RegExp(`^${PM}\\s+(?:run\\s+)?(?:test[:\\w-]*|t)(?![\\w-])`, 'i') },
  { class: 'test', pattern: /^(?:vitest|jest|mocha|pytest|rspec|phpunit|ctest)\b/i },
  { class: 'test', pattern: /^playwright\s+test\b/i },
  { class: 'test', pattern: new RegExp(`^${PM}\\s+(?:vitest|jest|mocha|playwright\\s+test)\\b`, 'i') },
  { class: 'typecheck', pattern: new RegExp(`^${PM}\\s+tsc\\b`, 'i') },
  { class: 'lint', pattern: new RegExp(`^${PM}\\s+eslint\\b`, 'i') },
  { class: 'test', pattern: /^(?:go|cargo|dotnet)\s+test\b/i },
  { class: 'test', pattern: new RegExp(`^${JVM}\\b.*\\b(?:test|verify|check)\\b`, 'i') },
  { class: 'test', pattern: /^make\s+(?:test|check)\b/i },
  { class: 'typecheck', pattern: /^tsc\b/i },
  { class: 'typecheck', pattern: new RegExp(`^${PM}\\s+(?:run\\s+)?typecheck\\b`, 'i') },
  { class: 'typecheck', pattern: /^(?:mypy|pyright)\b/i },
  { class: 'typecheck', pattern: /^cargo\s+check\b/i },
  { class: 'lint', pattern: /^eslint\b/i },
  { class: 'lint', pattern: new RegExp(`^${PM}\\s+(?:run\\s+)?lint\\b`, 'i') },
  { class: 'lint', pattern: /^(?:ruff|flake8|golangci-lint)\b/i },
  { class: 'lint', pattern: /^cargo\s+clippy\b/i },
  { class: 'build', pattern: new RegExp(`^${PM}\\s+run\\s+(?:build|compile)\\b`, 'i') },
  { class: 'build', pattern: /^(?:dotnet|cargo)\s+build\b/i },
  { class: 'build', pattern: /^go\s+(?:build|vet)\b/i },
  { class: 'build', pattern: new RegExp(`^${JVM}\\b.*\\b(?:build|compile|package)\\b`, 'i') },
  { class: 'build', pattern: /^make(?:\s+build)?\s*$/i },
  { class: 'install', pattern: new RegExp(`^${PM}\\s+(?:install|add|ci|i)\\b`, 'i') },
  { class: 'install', pattern: /^pip3?\s+install\b/i },
  { class: 'install', pattern: /^(?:cargo|dotnet)\s+add\b/i },
  { class: 'install', pattern: /^go\s+get\b/i },
  { class: 'git', pattern: /^(?:git|gh)\b/i },
  { class: 'network', pattern: /^(?:curl|wget|invoke-webrequest|iwr)\b/i },
  { class: 'filesystem', pattern: /^(?:rm|mv|cp|mkdir|rmdir|del|touch|remove-item)\b/i },
  { class: 'run', pattern: /^(?:node|python3?|deno)\b/i },
  { class: 'run', pattern: /^(?:dotnet|cargo|go)\s+run\b/i },
  { class: 'run', pattern: new RegExp(`^${PM}\\s+(?:start|run\\s+dev)\\b`, 'i') },
];

/** Wrappers that run another command; stripped so the wrapped command is classified. */
const WRAPPER = /^(?:npx|bunx|pnpm\s+exec|pnpm\s+dlx|yarn\s+exec|yarn\s+dlx|python3?\s+-m|dotnet\s+tool\s+run|time|sudo)\s+/i;
const ENV_ASSIGNMENT = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/;
const SEPARATOR = /(&&|\|\||;|\|)/;

interface Segment {
  text: string;
  /** The operator that FOLLOWS this segment, if any. */
  next?: string;
}

/** Split a command line into segments, ignoring separators inside quotes. */
function segments(command: string): Segment[] {
  // Blank out quoted strings so `git commit -m "a; b"` is one segment. Lengths
  // are preserved only loosely; nothing downstream reads the quoted content.
  const unquoted = command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
  const parts = unquoted.split(SEPARATOR);
  const result: Segment[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const text = parts[i].trim();
    const next = parts[i + 1];
    if (text.length > 0 || next !== undefined) {
      result.push({ text, ...(next !== undefined ? { next } : {}) });
    }
  }
  return result;
}

function classifySegment(raw: string): CommandClass {
  let text = raw.trim().replace(ENV_ASSIGNMENT, '');
  // A wrapper can wrap a wrapper (`sudo npx …`); a handful of passes is plenty.
  for (let i = 0; i < 3 && WRAPPER.test(text); i += 1) {
    text = text.replace(WRAPPER, '').replace(ENV_ASSIGNMENT, '');
  }
  for (const rule of COMMAND_CLASS_RULES) {
    if (rule.pattern.test(text)) {
      return rule.class;
    }
  }
  return 'other';
}

/**
 * Classify one command line.
 *
 * A compound command takes the most verifying class it contains (test over
 * typecheck over lint over build), else the first recognised class.
 * `resultMasked` says the tool result's error flag is not that command's exit
 * status: the verifying segment is piped, is followed by `||`, or is followed
 * by another command after `;`. An `&&` chain preserves a failure and does not
 * mask.
 */
export function classifyCommand(text: string): {
  class: CommandClass;
  resultMasked: boolean;
  maskedBy?: MaskForm;
  /**
   * With `maskedBy: 'truncate'`: the fewest lines any stage of the pipe lets
   * through (`tail -5` is 5). Absent when no stage cuts (`tee`, `cat`), so an
   * output shorter than this was not cut at all.
   */
  maskLines?: number;
} {
  const parts = segments(text);
  let best: CommandClass = 'other';
  let bestRank = Number.POSITIVE_INFINITY;
  let masked = false;
  let maskedBy: MaskForm | undefined;
  let maskLines: number | undefined;
  let firstOther: CommandClass = 'other';

  for (let i = 0; i < parts.length; i += 1) {
    const cls = classifySegment(parts[i].text);
    if (firstOther === 'other' && cls !== 'other') {
      firstOther = cls;
    }
    if (!isVerificationClass(cls)) {
      continue;
    }
    const rank = VERIFICATION_CLASSES.indexOf(cls);
    const next = parts[i].next;
    const laterSegment = parts.slice(i + 1).some((p) => p.text.length > 0);
    const segmentMasked = next === '|' || next === '||' || (next === ';' && laterSegment);
    const mask = segmentMasked ? maskForm(parts, i) : undefined;
    if (rank < bestRank) {
      best = cls;
      bestRank = rank;
      masked = segmentMasked;
      maskedBy = mask?.form;
      maskLines = mask?.lines;
    } else if (rank === bestRank) {
      // Two runs of the same class: the LAST one decides what the result says.
      masked = segmentMasked;
      maskedBy = mask?.form;
      maskLines = mask?.lines;
    }
  }
  if (bestRank === Number.POSITIVE_INFINITY) {
    return { class: firstOther, resultMasked: false };
  }
  return {
    class: best,
    resultMasked: masked,
    ...(maskedBy !== undefined ? { maskedBy } : {}),
    ...(maskedBy === 'truncate' && maskLines !== undefined ? { maskLines } : {}),
  };
}

const TRUNCATING_PIPE = /^(?:tail|head|tee|cat|less|more|out-host|out-string|select-object)\b/i;
const FILTERING_PIPE = /^(?:e?grep|fgrep|rg|findstr|select-string|sls|awk|sed|wc|sort|uniq|cut|jq|where-object|measure-object)\b/i;

/** How the segment at `index` is masked, reading the pipe chain that follows it. */
function maskForm(parts: readonly Segment[], index: number): { form: MaskForm; lines?: number } {
  const next = parts[index].next;
  if (next === '||') {
    return { form: 'or' };
  }
  if (next === ';') {
    return { form: 'sequence' };
  }
  // A pipe chain: one filtering stage anywhere makes the whole chain a filter.
  let form: MaskForm = 'truncate';
  let lines: number | undefined;
  for (let i = index; i < parts.length && parts[i].next === '|'; i += 1) {
    const stage = parts[i + 1]?.text ?? '';
    if (FILTERING_PIPE.test(stage)) {
      return { form: 'filter' };
    }
    if (!TRUNCATING_PIPE.test(stage)) {
      form = 'pipe';
      continue;
    }
    const limit = stageLineLimit(stage);
    if (limit !== undefined) {
      lines = lines === undefined ? limit : Math.min(lines, limit);
    }
  }
  return form === 'truncate' && lines !== undefined ? { form, lines } : { form };
}

/** How many lines a truncating stage lets through; `undefined` when it passes everything on. */
function stageLineLimit(stage: string): number | undefined {
  if (/^(?:tail|head)\b/i.test(stage)) {
    const explicit = /\s-(?:n\s*)?\+?(\d+)\b/.exec(stage) ?? /\s--lines[=\s]\+?(\d+)\b/.exec(stage);
    // `tail` and `head` print ten lines when no count is given.
    return explicit !== null ? Number(explicit[1]) : 10;
  }
  if (/^select-object\b/i.test(stage)) {
    const explicit = /-(?:first|last)\s+(\d+)\b/i.exec(stage);
    return explicit !== null ? Number(explicit[1]) : undefined;
  }
  return undefined;
}

// ── Risky actions ───────────────────────────────────────────────────────────

export type RiskId =
  | 'rm-rf'
  | 'force-push'
  | 'no-verify'
  | 'hard-reset'
  | 'credential-in-command'
  | 'write-outside-repo'
  | 'package-install'
  | 'network-call'
  | 'ci-change'
  | 'env-file-write'
  | 'permission-bypass'
  | 'sudo'
  | 'pipe-to-shell';

export interface RiskRule {
  id: RiskId;
  /** Fixed, generic wording. Never interpolated with session content. */
  label: string;
  /** Matched against a command line. */
  pattern?: RegExp;
  /** Matched against a repo-relative POSIX path. */
  pathPattern?: RegExp;
}

export const RISK_RULES: readonly RiskRule[] = [
  {
    id: 'rm-rf',
    label: 'Recursive forced delete',
    pattern: /\brm\s+(?:-[a-z]*r[a-z]*f[a-z]*|-[a-z]*f[a-z]*r[a-z]*|-r\s+-f|-f\s+-r)\b|\bremove-item\b[^|;&]*-recurse\b[^|;&]*-force\b|\bremove-item\b[^|;&]*-force\b[^|;&]*-recurse\b/i,
  },
  { id: 'force-push', label: 'Force push', pattern: /\bgit\s+push\b[^|;&]*(?:--force(?:-with-lease)?\b|\s-f\b)/i },
  { id: 'no-verify', label: 'Hooks skipped with --no-verify', pattern: /--no-verify\b/i },
  { id: 'hard-reset', label: 'Hard reset or forced clean', pattern: /\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-z]*f/i },
  {
    id: 'credential-in-command',
    label: 'Credential-looking string in a command',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bsk-[A-Za-z0-9_-]{20,}|\bAKIA[0-9A-Z]{16}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bBearer\s+[A-Za-z0-9._-]{20,}|\b(?:password|passwd|token|secret|api[_-]?key)\s*[=:]\s*[^\s"']{8,}/i,
  },
  {
    id: 'package-install',
    label: 'Package installed',
    pattern: /\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|i)\s+[^-\s]|\bpip3?\s+install\b|\bcargo\s+add\b|\bgo\s+get\b|\bdotnet\s+add\b[^|;&]*\bpackage\b/i,
  },
  { id: 'network-call', label: 'Network call from the shell', pattern: /\b(?:curl|wget|invoke-webrequest|iwr)\b/i },
  {
    id: 'pipe-to-shell',
    label: 'Download piped into a shell',
    pattern: /\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z|k)?sh\b|\b(?:iwr|invoke-webrequest)\b[^|]*\|\s*(?:iex|invoke-expression)\b/i,
  },
  { id: 'sudo', label: 'Ran with sudo', pattern: /(?:^|[;&|]\s*)sudo\b/i },
  {
    id: 'permission-bypass',
    label: 'Permission checks bypassed',
    pattern: /--dangerously-skip-permissions\b|--allow-all(?:-tools|-paths)?\b|--yolo\b/i,
  },
  {
    id: 'ci-change',
    label: 'CI or workflow file changed',
    pathPattern: /^\.github\/workflows\/|(?:^|\/)\.gitlab-ci\.yml$|(?:^|\/)azure-pipelines\.ya?ml$|(?:^|\/)Jenkinsfile$|^\.circleci\//,
  },
  { id: 'env-file-write', label: 'Environment file written', pathPattern: /(?:^|\/)\.env(?:\.[\w.-]+)?$/ },
  { id: 'write-outside-repo', label: 'File written outside the repository' },
];

/** Risk ids a command line raises, in table order, each at most once. */
export function detectCommandRisks(text: string): RiskId[] {
  const found: RiskId[] = [];
  for (const rule of RISK_RULES) {
    if (rule.pattern !== undefined && rule.pattern.test(text)) {
      found.push(rule.id);
    }
  }
  return found;
}

/** Risk ids an edited path raises. `repoPath` is repo-relative POSIX when inside. */
export function detectPathRisks(repoPath: string, insideRepo: boolean): RiskId[] {
  if (!insideRepo) {
    return ['write-outside-repo'];
  }
  const found: RiskId[] = [];
  for (const rule of RISK_RULES) {
    if (rule.pathPattern !== undefined && rule.pathPattern.test(repoPath)) {
      found.push(rule.id);
    }
  }
  return found;
}

/** A session permission mode that removes the approval step. */
export function isBypassPermissionMode(mode: string): boolean {
  return mode === 'bypassPermissions' || mode === 'dontAsk';
}

// ── File roll-up ────────────────────────────────────────────────────────────

/**
 * Maps a path as recorded to its display form. Injected so this module never
 * imports `node:path`; the datahost supplies one built on the repo-root rule.
 */
export type RepoPathFn = (recorded: string) => { path: string; insideRepo: boolean };

export interface FileRollup {
  /** Repo-relative POSIX path, or a bare name when outside the repository. */
  path: string;
  insideRepo: boolean;
  linesAdded: number;
  linesRemoved: number;
  /** Edit-tool calls on the file. */
  edits: number;
  /** Edits made in a later turn than the file's first edit. */
  reEdits: number;
  /** Distinct turns that edited the file. */
  turns: number;
  firstTurn: number;
  lastTurn: number;
}

/** Fold edit calls per file. Most-edited first, then by path, so order is stable. */
export function rollupFiles(edits: readonly ActivityFileEdit[], toRepoPath: RepoPathFn): FileRollup[] {
  const byPath = new Map<string, FileRollup & { turnSet: Set<number> }>();
  for (const edit of edits) {
    const mapped = toRepoPath(edit.path);
    let row = byPath.get(mapped.path);
    if (row === undefined) {
      row = {
        path: mapped.path,
        insideRepo: mapped.insideRepo,
        linesAdded: 0,
        linesRemoved: 0,
        edits: 0,
        reEdits: 0,
        turns: 0,
        firstTurn: edit.turnIndex,
        lastTurn: edit.turnIndex,
        turnSet: new Set<number>(),
      };
      byPath.set(mapped.path, row);
    }
    row.edits += 1;
    row.linesAdded += edit.linesAdded;
    row.linesRemoved += edit.linesRemoved;
    row.firstTurn = Math.min(row.firstTurn, edit.turnIndex);
    row.lastTurn = Math.max(row.lastTurn, edit.turnIndex);
    row.turnSet.add(edit.turnIndex);
  }
  const rows: FileRollup[] = [];
  for (const [path, row] of byPath) {
    const { turnSet, ...rest } = row;
    const reEdits = edits.filter((e) => toRepoPath(e.path).path === path && e.turnIndex > row.firstTurn).length;
    rows.push({ ...rest, turns: turnSet.size, reEdits });
  }
  return rows.sort((a, b) => b.edits - a.edits || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
