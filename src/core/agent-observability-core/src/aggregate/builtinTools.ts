/**
 * Built-in Copilot tool allowlist (privacy-critical mapping).
 *
 * Per `docs/architecture/aggregate-payload-schema-v1.md` §5.1: built-in Copilot
 * tool names pass through verbatim, but any third-party / MCP tool name (one
 * outside this allowlist) is vendor-defined and could embed project/customer
 * identifiers, so it MUST be collapsed to the literal `custom` BEFORE it reaches
 * a bucket key or payload. Only the mapped value ever ships.
 *
 * The allowlist is intentionally a closed, low-cardinality set of known editor
 * tools. Anything unrecognized maps to `custom`.
 */

/** Literal substituted for any non-allowlisted (third-party / MCP) tool name. */
export const CUSTOM_TOOL = 'custom';

/**
 * Known built-in Copilot tool names that pass through verbatim. Matched
 * case-sensitively against `gen_ai.tool.name` / `spans.tool_name`.
 */
export const BUILTIN_TOOLS: ReadonlySet<string> = new Set<string>([
  'read_file',
  'run_in_terminal',
  'list_dir',
  'create_file',
  'create_directory',
  'replace_string_in_file',
  'multi_replace_string_in_file',
  'apply_patch',
  'insert_edit_into_file',
  'file_search',
  'grep_search',
  'semantic_search',
  'list_code_usages',
  'get_errors',
  'test_search',
  'run_tests',
  'manage_todo_list',
  'runSubagent',
  'fetch_webpage',
  'get_terminal_output',
]);

/**
 * Map a raw tool name to the allowlisted value: a built-in name passes through
 * verbatim; anything else (blank, third-party, MCP) becomes the literal
 * {@link CUSTOM_TOOL}. Returns `undefined` only for a null/undefined input so the
 * caller can omit `toolName` for non-tool operations.
 */
export function mapToolName(raw: string | null | undefined): string | undefined {
  if (raw === null || raw === undefined) {
    return undefined;
  }
  const name = raw.trim();
  if (name.length === 0) {
    return CUSTOM_TOOL;
  }
  return BUILTIN_TOOLS.has(name) ? name : CUSTOM_TOOL;
}
