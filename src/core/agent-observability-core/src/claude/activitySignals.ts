import {
  classifyCommand,
  isVerificationClass,
  type ActivityCommand,
  type ActivityFileEdit,
  type ActivityFileRead,
  type MaskForm,
  type SessionActivity,
  type VerificationClass,
  type VerificationOutcome,
} from '../analysis/sessionActivity';
import { VERIFICATION_OUTPUT_MAX_CHARS, classifyVerificationOutput } from '../analysis/verificationOutput';
import { contentBlocks, messageText, type ContentBlock, type TranscriptRecord } from './transcript';

/**
 * The second raw-content chokepoint for Claude Code transcripts, beside
 * `retrospectiveSignals.ts`: records in, a {@link SessionActivity} out.
 *
 * It is the ONLY place that reads tool INPUTS — shell command text, edited and
 * read file paths — so every feature that needs them (completion check,
 * rework, review packet, hand-off brief) reads the same answer, and the
 * privacy boundary is one file. Tool RESULTS are read for three
 * things only: whether the call errored (`is_error`); for edit tools, the
 * structured patch's added and removed lines; and, for VERIFICATION commands
 * (test, build, lint, type-check) only, the tail of the output, in memory, to
 * classify the check's own result as passed, failed or unknown. Output text,
 * file contents and diffs never leave this function.
 *
 * Pure: no I/O. The caller hands over records it already holds (the session
 * service's mtime-keyed cache), so nothing is parsed twice.
 */

/** How much of the closing assistant text is kept for phrase classification. */
export const CLOSING_TEXT_MAX_CHARS = 1200;

const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell']);
const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS: ReadonlySet<string> = new Set(['Read', 'NotebookRead']);
const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(['Task', 'Agent']);

interface ToolResult {
  isError: boolean;
  /** The raw result block and structured result, kept ONLY so a verification command's output can be classified. */
  block?: ContentBlock;
  structured?: unknown;
  added?: number;
  removed?: number;
  /** RAW patch line text, kept only until the rework matcher has counted it. */
  addedText?: string[];
  removedText?: string[];
}

/** Lines tracked per file by the rework matcher; beyond it new additions are not remembered. */
export const REWORK_MAX_TRACKED_LINES = 5000;
/** A line needs this many non-space characters to count (so a lone brace does not). */
export const REWORK_MIN_LINE_CHARS = 3;

/**
 * Counts lines an EARLIER turn added to a file that a LATER turn removed.
 * Holds normalised line text in memory while the session is walked and gives
 * back integers only.
 */
class ReworkMatcher {
  private readonly files = new Map<string, { lines: Map<string, number[]>; tracked: number; reworked: number }>();

  record(file: string, turnIndex: number, added: readonly string[], removed: readonly string[]): void {
    let entry = this.files.get(file);
    if (entry === undefined) {
      entry = { lines: new Map(), tracked: 0, reworked: 0 };
      this.files.set(file, entry);
    }
    // Removals first: a line an edit both removes and re-adds is not rework
    // of itself, and its fresh copy must not satisfy its own removal.
    for (const raw of removed) {
      const line = normalizeLine(raw);
      if (line === undefined) {
        continue;
      }
      const turns = entry.lines.get(line);
      if (turns === undefined) {
        continue;
      }
      const at = turns.findIndex((turn) => turn < turnIndex);
      if (at >= 0) {
        turns.splice(at, 1);
        entry.tracked -= 1;
        entry.reworked += 1;
        if (turns.length === 0) {
          entry.lines.delete(line);
        }
      }
    }
    for (const raw of added) {
      if (entry.tracked >= REWORK_MAX_TRACKED_LINES) {
        break;
      }
      const line = normalizeLine(raw);
      if (line === undefined) {
        continue;
      }
      const turns = entry.lines.get(line);
      if (turns === undefined) {
        entry.lines.set(line, [turnIndex]);
      } else {
        turns.push(turnIndex);
      }
      entry.tracked += 1;
    }
  }

  counts(): Record<string, number> | undefined {
    const out: Record<string, number> = {};
    let any = false;
    for (const [file, entry] of this.files) {
      if (entry.reworked > 0) {
        out[file] = entry.reworked;
        any = true;
      }
    }
    return any ? out : undefined;
  }
}

/** Collapse whitespace; `undefined` for lines too short to mean anything. */
function normalizeLine(raw: string): string | undefined {
  const line = raw.replace(/\s+/g, ' ').trim();
  return line.replace(/ /g, '').length >= REWORK_MIN_LINE_CHARS ? line : undefined;
}

/**
 * The lines an edit added and removed. A patch is exact; without one, the
 * tool's own strings are compared as multisets so unchanged context lines
 * inside `old_string`/`new_string` are not mistaken for a removal and a re-add.
 */
function editLineText(
  tool: string,
  input: Record<string, unknown> | undefined,
  result: ToolResult | undefined,
): { added: string[]; removed: string[] } {
  if (result?.addedText !== undefined || result?.removedText !== undefined) {
    return { added: result.addedText ?? [], removed: result.removedText ?? [] };
  }
  if (input === undefined) {
    return { added: [], removed: [] };
  }
  if (tool === 'Write') {
    return { added: splitLines(input.content), removed: [] };
  }
  const pairs: { oldText: unknown; newText: unknown }[] =
    tool === 'MultiEdit' && Array.isArray(input.edits)
      ? input.edits.map((edit) => ({ oldText: asObject(edit)?.old_string, newText: asObject(edit)?.new_string }))
      : [{ oldText: input.old_string, newText: input.new_string ?? input.new_source }];
  const added: string[] = [];
  const removed: string[] = [];
  for (const pair of pairs) {
    const kept = new Map<string, number>();
    for (const line of splitLines(pair.oldText)) {
      kept.set(line, (kept.get(line) ?? 0) + 1);
    }
    for (const line of splitLines(pair.newText)) {
      const left = kept.get(line) ?? 0;
      if (left > 0) {
        kept.set(line, left - 1);
      } else {
        added.push(line);
      }
    }
    for (const [line, left] of kept) {
      for (let i = 0; i < left; i += 1) {
        removed.push(line);
      }
    }
  }
  return { added, removed };
}

function splitLines(value: unknown): string[] {
  return typeof value === 'string' && value.length > 0 ? value.split('\n') : [];
}

export function extractSessionActivity(
  mainRecords: readonly TranscriptRecord[],
  sideChainRecords: readonly TranscriptRecord[] = [],
): SessionActivity {
  const results = indexResults(mainRecords);
  const sideResults = indexResults(sideChainRecords);

  const commands: ActivityCommand[] = [];
  const edits: ActivityFileEdit[] = [];
  const reads: ActivityFileRead[] = [];
  const permissionModes = new Set<string>();
  const subAgents = new Map<string, number>();
  const touched = new Set<string>();
  const rework = new ReworkMatcher();
  /** Main-thread tool calls in order, for the trailing-failure count. */
  const mainCalls: { failed: boolean; known: boolean }[] = [];
  let closingText: string | undefined;
  let turnIndex = -1;
  let order = 0;
  /** Sub-agent call id → its position, so side-chain commands can be placed. */
  const spawnOrder = new Map<string, number>();
  let firstSpawnOrder = -1;

  for (const record of mainRecords) {
    if (typeof record.permissionMode === 'string' && record.permissionMode.length > 0) {
      permissionModes.add(record.permissionMode);
    }
    if (record.isSidechain === true) {
      continue;
    }
    if (isUserRequest(record)) {
      turnIndex += 1;
      continue;
    }
    if (record.type !== 'assistant' || record.message === undefined) {
      continue;
    }
    const text = messageText(record.message).trim();
    if (text.length > 0) {
      closingText = text.slice(-CLOSING_TEXT_MAX_CHARS);
    }
    for (const block of contentBlocks(record.message)) {
      if (block.type !== 'tool_use' || typeof block.name !== 'string') {
        continue;
      }
      const result = typeof block.id === 'string' ? results.get(block.id) : undefined;
      mainCalls.push({ failed: result?.isError === true, known: result !== undefined });
      if (SUBAGENT_TOOLS.has(block.name)) {
        if (typeof block.id === 'string') {
          spawnOrder.set(block.id, order);
        }
        if (firstSpawnOrder < 0) {
          firstSpawnOrder = order;
        }
      }
      collectCall(block, result, turnIndex, order, { commands, edits, reads, subAgents, touched, rework });
      order += 1;
    }
  }

  // Side-chain shell commands count: a sub-agent may be the one running the
  // tests. Each is placed at the sub-agent call that spawned it; when the
  // link is missing it takes the FIRST spawn's position, which can only
  // under-claim "a check ran after the last edit", never over-claim it.
  for (const record of sideChainRecords) {
    if (record.type !== 'assistant' || record.message === undefined) {
      continue;
    }
    for (const block of contentBlocks(record.message)) {
      if (block.type !== 'tool_use' || typeof block.name !== 'string' || !SHELL_TOOLS.has(block.name)) {
        continue;
      }
      const result = typeof block.id === 'string' ? sideResults.get(block.id) : undefined;
      const source = typeof record.sourceToolUseID === 'string' ? spawnOrder.get(record.sourceToolUseID) : undefined;
      const command = shellCommand(block, result, turnIndex, source ?? firstSpawnOrder, true);
      if (command !== undefined) {
        commands.push(command);
      }
    }
  }

  let trailingFailedTools = 0;
  for (let i = mainCalls.length - 1; i >= 0 && mainCalls[i].known && mainCalls[i].failed; i -= 1) {
    trailingFailedTools += 1;
  }

  const reworked = rework.counts();
  return {
    commands,
    edits,
    reads,
    permissionModes: [...permissionModes].sort(),
    subAgents: [...subAgents.entries()]
      .map(([name, calls]) => ({ name, calls }))
      .sort((a, b) => b.calls - a.calls || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    ...(closingText !== undefined ? { closingText } : {}),
    endedOnFailedTool: trailingFailedTools > 0 && endsOnToolResult(mainRecords),
    trailingFailedTools,
    complete: true,
    ...(reworked !== undefined ? { reworkedLinesByFile: reworked } : {}),
  };
}

interface Sinks {
  commands: ActivityCommand[];
  edits: ActivityFileEdit[];
  reads: ActivityFileRead[];
  subAgents: Map<string, number>;
  touched: Set<string>;
  rework: ReworkMatcher;
}

function collectCall(
  block: ContentBlock,
  result: ToolResult | undefined,
  turnIndex: number,
  order: number,
  sinks: Sinks,
): void {
  const name = block.name as string;
  const input = asObject(block.input);

  if (SHELL_TOOLS.has(name)) {
    const command = shellCommand(block, result, turnIndex, order, false);
    if (command !== undefined) {
      sinks.commands.push(command);
    }
    return;
  }

  if (EDIT_TOOLS.has(name)) {
    const path = stringField(input, 'file_path') ?? stringField(input, 'notebook_path');
    if (path === undefined) {
      return;
    }
    const counted = result?.added !== undefined ? { added: result.added, removed: result.removed ?? 0 } : inputLineCounts(name, input);
    sinks.edits.push({
      order,
      turnIndex,
      path,
      linesAdded: counted.added,
      linesRemoved: counted.removed,
      created: name === 'Write' && !sinks.touched.has(path),
      tool: name,
    });
    sinks.touched.add(path);
    if (result?.isError !== true) {
      const text = editLineText(name, input, result);
      sinks.rework.record(path, turnIndex, text.added, text.removed);
    }
    return;
  }

  if (READ_TOOLS.has(name)) {
    const path = stringField(input, 'file_path') ?? stringField(input, 'notebook_path');
    if (path !== undefined) {
      sinks.reads.push({ order, turnIndex, path });
      sinks.touched.add(path);
    }
    return;
  }

  if (SUBAGENT_TOOLS.has(name)) {
    const agent = stringField(input, 'subagent_type') ?? 'general-purpose';
    sinks.subAgents.set(agent, (sinks.subAgents.get(agent) ?? 0) + 1);
  }
}

function shellCommand(
  block: ContentBlock,
  result: ToolResult | undefined,
  turnIndex: number,
  order: number,
  sideChain: boolean,
): ActivityCommand | undefined {
  const input = asObject(block.input);
  const text = stringField(input, 'command');
  if (text === undefined || text.trim().length === 0) {
    return undefined;
  }
  const classified = classifyCommand(text);
  const background = input?.run_in_background === true;
  return {
    order,
    turnIndex,
    class: classified.class,
    failed: result?.isError === true,
    resultKnown: result !== undefined,
    resultMasked: classified.resultMasked,
    background,
    sideChain,
    ...(classified.maskedBy !== undefined ? { maskedBy: classified.maskedBy } : {}),
    ...(isVerificationClass(classified.class)
      ? { outcome: verificationOutcome(classified.class, classified.resultMasked, classified.maskedBy, classified.maskLines, background, result) }
      : {}),
    text,
  };
}

/** Checks that print nothing when they succeed, so silence behind a truncating pipe is their pass. */
const SILENT_ON_SUCCESS: ReadonlySet<VerificationClass> = new Set<VerificationClass>(['typecheck', 'lint']);

/**
 * What the session recorded about a check's own result.
 *
 * Unmasked: the tool call's error flag IS the exit status. A failure marker in
 * the output still wins over a clean flag (a wrapper that swallowed the exit
 * code). Masked or started in the background: only the check's own output can
 * say, and `passed` needs a positive marker — with one narrow exception: a
 * type-check or lint behind a pipe that only truncates (`| tail`, `| head`)
 * that printed nothing of its own (see {@link isSilentRun}). Those tools are
 * silent on success and always print on failure, and a truncating pipe hides
 * nothing when nothing was cut.
 *
 * This is the only place a tool result's text is read; only the three-valued
 * outcome leaves.
 */
function verificationOutcome(
  cls: VerificationClass,
  masked: boolean,
  maskedBy: MaskForm | undefined,
  maskLines: number | undefined,
  background: boolean,
  result: ToolResult | undefined,
): VerificationOutcome {
  if (result === undefined || background) {
    return 'unknown';
  }
  const output = resultOutput(result);
  const byOutput = classifyVerificationOutput(cls, output);
  if (!masked) {
    return result.isError || byOutput === 'failed' ? 'failed' : 'passed';
  }
  if (byOutput !== 'unknown') {
    return byOutput;
  }
  if (maskedBy === 'truncate' && SILENT_ON_SUCCESS.has(cls) && !result.isError && isSilentRun(output, maskLines)) {
    return 'passed';
  }
  return 'unknown';
}

/** A package-manager script banner (`> name@1.0.0 script`, `> tsc --noEmit`) or an npm notice. */
const BANNER_LINE = /^(?:>\s|\$\s|npm (?:warn|notice)\b|yarn run v|Done in [\d.]+s)/i;

/**
 * Whether a silent-on-success check printed nothing of its own: no output at
 * all, or only script banners — and, for banners, only when the pipe cannot
 * have cut anything (fewer lines arrived than the stage lets through), since
 * `tail -3` over several workspaces could hide an earlier one's errors.
 */
function isSilentRun(output: string, maskLines: number | undefined): boolean {
  const trimmed = output.replace(/\r\n?/g, '\n').trim();
  if (trimmed.length === 0) {
    return true;
  }
  const lines = trimmed.split('\n');
  if (maskLines !== undefined && lines.length >= maskLines) {
    return false;
  }
  return lines.every((line) => line.trim().length === 0 || BANNER_LINE.test(line.trim()));
}

/** The tail of a tool result's text: the result block, plus stdout/stderr when the record carries them. */
function resultOutput(result: ToolResult): string {
  const parts: string[] = [];
  const content = result.block?.content;
  if (typeof content === 'string') {
    parts.push(content);
  } else if (Array.isArray(content)) {
    for (const piece of content) {
      const text = asObject(piece)?.text;
      if (typeof text === 'string') {
        parts.push(text);
      }
    }
  }
  if (parts.every((part) => part.trim().length === 0)) {
    const structured = asObject(result.structured);
    for (const key of ['stdout', 'stderr']) {
      const value = structured?.[key];
      if (typeof value === 'string' && value.length > 0) {
        parts.push(value);
      }
    }
  }
  const joined = parts.join('\n');
  return joined.length > VERIFICATION_OUTPUT_MAX_CHARS ? joined.slice(-VERIFICATION_OUTPUT_MAX_CHARS) : joined;
}

/** `tool_use_id → outcome` from every `tool_result` block, with patch line counts when present. */
function indexResults(records: readonly TranscriptRecord[]): Map<string, ToolResult> {
  const index = new Map<string, ToolResult>();
  for (const record of records) {
    if (record.type !== 'user' || record.message === undefined) {
      continue;
    }
    const resultBlocks = contentBlocks(record.message).filter(
      (b) => b.type === 'tool_result' && typeof b.tool_use_id === 'string',
    );
    if (resultBlocks.length === 0) {
      continue;
    }
    // `toolUseResult` describes the record's one result; with several results
    // on one record it cannot be attributed, so the patch is left out.
    const patch = resultBlocks.length === 1 ? patchLineCounts(record.toolUseResult?.structuredPatch) : undefined;
    const text = patch !== undefined ? patchLineText(record.toolUseResult?.structuredPatch) : undefined;
    for (const block of resultBlocks) {
      index.set(block.tool_use_id as string, {
        isError: block.is_error === true,
        block,
        ...(resultBlocks.length === 1 && record.toolUseResult !== undefined ? { structured: record.toolUseResult } : {}),
        ...(patch !== undefined ? { added: patch.added, removed: patch.removed } : {}),
        ...(text !== undefined ? { addedText: text.added, removedText: text.removed } : {}),
      });
    }
  }
  return index;
}

/** Count `+` and `-` lines across structured-patch hunks; `undefined` when there is no patch. */
function patchLineCounts(patch: unknown): { added: number; removed: number } | undefined {
  if (!Array.isArray(patch) || patch.length === 0) {
    return undefined;
  }
  let added = 0;
  let removed = 0;
  let sawHunk = false;
  for (const hunk of patch) {
    const lines = asObject(hunk)?.lines;
    if (!Array.isArray(lines)) {
      continue;
    }
    sawHunk = true;
    for (const line of lines) {
      if (typeof line !== 'string') {
        continue;
      }
      if (line.startsWith('+')) {
        added += 1;
      } else if (line.startsWith('-')) {
        removed += 1;
      }
    }
  }
  return sawHunk ? { added, removed } : undefined;
}

/** The `+` and `-` line texts of a structured patch (prefix stripped), for the rework matcher. */
function patchLineText(patch: unknown): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  if (Array.isArray(patch)) {
    for (const hunk of patch) {
      const lines = asObject(hunk)?.lines;
      if (!Array.isArray(lines)) {
        continue;
      }
      for (const line of lines) {
        if (typeof line !== 'string') {
          continue;
        }
        if (line.startsWith('+')) {
          added.push(line.slice(1));
        } else if (line.startsWith('-')) {
          removed.push(line.slice(1));
        }
      }
    }
  }
  return { added, removed };
}

/** Fallback when no patch came back: line counts of the tool's own input strings. */
function inputLineCounts(tool: string, input: Record<string, unknown> | undefined): { added: number; removed: number } {
  if (input === undefined) {
    return { added: 0, removed: 0 };
  }
  if (tool === 'Write') {
    return { added: lineCount(input.content), removed: 0 };
  }
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    let added = 0;
    let removed = 0;
    for (const edit of input.edits) {
      const e = asObject(edit);
      added += lineCount(e?.new_string);
      removed += lineCount(e?.old_string);
    }
    return { added, removed };
  }
  return { added: lineCount(input.new_string ?? input.new_source), removed: lineCount(input.old_string) };
}

function lineCount(value: unknown): number {
  if (typeof value !== 'string' || value.length === 0) {
    return 0;
  }
  return value.split('\n').length;
}

/** Same turn anchor as the mapper: a non-meta main-thread user record with real text. */
function isUserRequest(record: TranscriptRecord): boolean {
  if (record.type !== 'user' || record.message === undefined) {
    return false;
  }
  if (record.isMeta === true || record.isSidechain === true) {
    return false;
  }
  if (typeof record.message.content === 'string') {
    return record.message.content.trim().length > 0;
  }
  return contentBlocks(record.message).some(
    (b) => b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0,
  );
}

/** Whether the last main-thread user/assistant record is a tool-result delivery. */
function endsOnToolResult(records: readonly TranscriptRecord[]): boolean {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (record.isSidechain === true || record.message === undefined) {
      continue;
    }
    if (record.type === 'user') {
      const blocks = contentBlocks(record.message);
      return blocks.length > 0 && blocks.every((b) => b.type === 'tool_result');
    }
    if (record.type === 'assistant') {
      return false;
    }
  }
  return false;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(input: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = input?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
