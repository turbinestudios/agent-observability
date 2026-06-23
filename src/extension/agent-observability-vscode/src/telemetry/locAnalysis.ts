/**
 * LOCAL-ONLY analysis of how many lines an agent WROTE and REMOVED, split into
 * code vs documentation by file extension.
 *
 * The source is the raw `gen_ai.tool.call.arguments` span attribute of
 * file-writing `execute_tool` spans (`create_file`, `apply_patch`,
 * `insert_edit_into_file`, `replace_string_in_file`,
 * `multi_replace_string_in_file`). That attribute is RAW CONTENT and must never
 * leave the machine — this module is invoked only on the LOCAL detail/tree path,
 * and only the resulting integer line counts are retained (the cloud aggregate
 * path in `src/aggregate` never touches it).
 *
 * Pure module: no `vscode`, no I/O, no globals — so it is trivially unit-testable.
 * Parsing is fully defensive: any malformed/unknown shape yields all-zero rather
 * than throwing, so a stray tool-argument format can never break the panel.
 */

/** Lines attributed to each file class. */
export interface LineCounts {
  /** Lines in files whose extension is in the configured CODE list. */
  code: number;
  /** Lines in files whose extension is in the configured DOC list. */
  doc: number;
}

/** Added vs removed line counts for one (or many) write-tool call(s). */
export interface WriteLineDelta {
  /** Lines written/added. */
  added: LineCounts;
  /** Lines removed/replaced-away. */
  removed: LineCounts;
}

type FileClass = 'code' | 'doc';

function emptyDelta(): WriteLineDelta {
  return { added: { code: 0, doc: 0 }, removed: { code: 0, doc: 0 } };
}

/**
 * Normalize a raw settings array into a deduplicated list of lowercase
 * extensions, each guaranteed to start with a dot. Non-string and blank entries
 * are dropped. `["TS", ".md", "tsx"]` → `[".ts", ".md", ".tsx"]`.
 */
export function normalizeExtensions(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      continue;
    }
    let ext = item.trim().toLowerCase();
    if (ext.length === 0) {
      continue;
    }
    if (!ext.startsWith('.')) {
      ext = `.${ext}`;
    }
    if (!seen.has(ext)) {
      seen.add(ext);
      out.push(ext);
    }
  }
  return out;
}

/**
 * The lowercase extension (incl. leading dot) of a file path's last segment, or
 * `undefined` when there is none (no dot, or a dotfile like `.gitignore`).
 * Handles both `/` and `\` separators.
 */
function extractExtension(filePath: unknown): string | undefined {
  if (typeof filePath !== 'string') {
    return undefined;
  }
  const segment = filePath.split(/[\\/]/).pop() ?? '';
  const dot = segment.lastIndexOf('.');
  if (dot <= 0) {
    return undefined;
  }
  return segment.slice(dot).toLowerCase();
}

/**
 * Classify a file path as `'code'` or `'doc'` by its extension, or `undefined`
 * when it matches neither list (those lines count toward neither metric). The
 * code list is checked first. `codeExts`/`docExts` are expected to be
 * {@link normalizeExtensions}-normalized (lowercase, leading dot).
 */
export function classifyExtension(
  filePath: string,
  codeExts: readonly string[],
  docExts: readonly string[],
): FileClass | undefined {
  const ext = extractExtension(filePath);
  if (ext === undefined) {
    return undefined;
  }
  if (codeExts.includes(ext)) {
    return 'code';
  }
  if (docExts.includes(ext)) {
    return 'doc';
  }
  return undefined;
}

/**
 * Count the lines in a block of text. Empty string → 0. A trailing newline does
 * not add a phantom line, but a final line without one still counts. `"a\nb"` →
 * 2; `"a\nb\n"` → 2; `""` → 0.
 */
function countLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  let newlines = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      newlines++;
    }
  }
  return text.endsWith('\n') ? newlines : newlines + 1;
}

/** Add `n` lines of the given kind/class into `delta` (no-op for unclassified). */
function add(delta: WriteLineDelta, cls: FileClass | undefined, kind: 'added' | 'removed', n: number): void {
  if (cls !== undefined && n > 0) {
    delta[kind][cls] += n;
  }
}

/** `create_file` / `insert_edit_into_file`: whole content/code block is added. */
function wholeBlockDelta(
  filePath: unknown,
  body: unknown,
  codeExts: readonly string[],
  docExts: readonly string[],
): WriteLineDelta {
  const delta = emptyDelta();
  if (typeof filePath !== 'string' || typeof body !== 'string') {
    return delta;
  }
  add(delta, classifyExtension(filePath, codeExts, docExts), 'added', countLines(body));
  return delta;
}

/** `replace_string_in_file`: newString is added, oldString is removed. */
function replaceDelta(
  filePath: unknown,
  oldString: unknown,
  newString: unknown,
  codeExts: readonly string[],
  docExts: readonly string[],
): WriteLineDelta {
  const delta = emptyDelta();
  if (typeof filePath !== 'string') {
    return delta;
  }
  const cls = classifyExtension(filePath, codeExts, docExts);
  if (typeof newString === 'string') {
    add(delta, cls, 'added', countLines(newString));
  }
  if (typeof oldString === 'string') {
    add(delta, cls, 'removed', countLines(oldString));
  }
  return delta;
}

/**
 * `multi_replace_string_in_file`: a list of replacements. Accepts either a
 * top-level `replacements`/`edits` array or a bare array, with an optional
 * per-replacement `filePath` overriding the call-level one. Each element is
 * guarded independently.
 */
function multiReplaceDelta(
  args: Record<string, unknown>,
  codeExts: readonly string[],
  docExts: readonly string[],
): WriteLineDelta {
  const delta = emptyDelta();
  const baseFile = typeof args.filePath === 'string' ? args.filePath : undefined;
  const reps = Array.isArray(args.replacements)
    ? args.replacements
    : Array.isArray(args.edits)
      ? args.edits
      : undefined;
  if (reps === undefined) {
    return delta;
  }
  for (const rep of reps) {
    if (rep === null || typeof rep !== 'object') {
      continue;
    }
    const r = rep as Record<string, unknown>;
    const file = typeof r.filePath === 'string' ? r.filePath : baseFile;
    if (file === undefined) {
      continue;
    }
    const cls = classifyExtension(file, codeExts, docExts);
    if (typeof r.newString === 'string') {
      add(delta, cls, 'added', countLines(r.newString));
    }
    if (typeof r.oldString === 'string') {
      add(delta, cls, 'removed', countLines(r.oldString));
    }
  }
  return delta;
}

/**
 * `apply_patch`: walk the `*** Begin Patch … *** End Patch` body. The active file
 * is set by `*** Add/Update/Delete File:` headers; `+`-prefixed lines are added
 * and `-`-prefixed lines are removed (the `+++`/`---` diff markers and `*** `
 * directives are excluded). `Delete File` sections carry no body, so they add 0.
 * Multi-file patches re-classify at each header.
 */
function applyPatchDelta(
  input: unknown,
  codeExts: readonly string[],
  docExts: readonly string[],
): WriteLineDelta {
  const delta = emptyDelta();
  if (typeof input !== 'string') {
    return delta;
  }
  let cls: FileClass | undefined;
  for (const raw of input.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const header = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line);
    if (header !== null) {
      cls = classifyExtension(header[1].trim(), codeExts, docExts);
      continue;
    }
    if (line.startsWith('*** ')) {
      // Begin Patch / End Patch / End of File and similar directives.
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      add(delta, cls, 'added', 1);
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      add(delta, cls, 'removed', 1);
    }
  }
  return delta;
}

/**
 * Count the lines added and removed by a single file-writing tool call, split by
 * code/doc class. Unknown tools, malformed JSON, and missing fields all yield an
 * all-zero delta. `codeExts`/`docExts` must be {@link normalizeExtensions}-normalized.
 */
export function countWrittenLines(
  toolName: string,
  argumentsJson: string,
  codeExts: readonly string[],
  docExts: readonly string[],
): WriteLineDelta {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return emptyDelta();
  }
  if (parsed === null || typeof parsed !== 'object') {
    return emptyDelta();
  }
  const args = parsed as Record<string, unknown>;

  switch (toolName) {
    case 'create_file':
      return wholeBlockDelta(args.filePath, args.content, codeExts, docExts);
    case 'insert_edit_into_file':
      return wholeBlockDelta(args.filePath, args.code, codeExts, docExts);
    case 'replace_string_in_file':
      return replaceDelta(args.filePath, args.oldString, args.newString, codeExts, docExts);
    case 'multi_replace_string_in_file':
      return multiReplaceDelta(args, codeExts, docExts);
    case 'apply_patch':
      return applyPatchDelta(args.input, codeExts, docExts);
    default:
      return emptyDelta();
  }
}

/** Sum {@link countWrittenLines} over many write-tool spans. */
export function sumWrittenLines(
  spans: ReadonlyArray<{ toolName: string; argumentsJson: string }>,
  codeExts: readonly string[],
  docExts: readonly string[],
): WriteLineDelta {
  const total = emptyDelta();
  for (const span of spans) {
    const d = countWrittenLines(span.toolName, span.argumentsJson, codeExts, docExts);
    total.added.code += d.added.code;
    total.added.doc += d.added.doc;
    total.removed.code += d.removed.code;
    total.removed.doc += d.removed.doc;
  }
  return total;
}
