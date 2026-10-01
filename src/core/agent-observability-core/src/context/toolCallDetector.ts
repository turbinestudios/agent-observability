/**
 * Detects context-file reads from tool call arguments in the telemetry data.
 *
 * Looks at `read_file` tool calls that targeted paths within known context-file
 * directories (.github/, .copilot/, .claude/, .agents/, VS Code prompts folder).
 * These represent files that were explicitly read into the context window during
 * the session, beyond what the discovery/customization resolver loaded automatically.
 *
 * LOCAL-ONLY: file paths are extracted on-machine; never uploaded.
 */

import type { ContextFileCategory, ContextFileEntry } from './models';

/** A raw tool-read row from the database layer. */
export interface ToolReadRow {
  filePath: string;
  conversationId: string | null;
  chatSessionId: string | null;
}

/**
 * Convert tool-read rows into context file entries. Deduplicates by file path.
 * Only includes files that match known context-file patterns and aren't already
 * covered by discovery entries.
 */
export function parseToolReads(
  rows: readonly ToolReadRow[],
  alreadyKnownNames: ReadonlySet<string>,
): ContextFileEntry[] {
  const seen = new Set<string>();
  const entries: ContextFileEntry[] = [];

  for (const row of rows) {
    const normalized = row.filePath.replace(/\\/g, '/');
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    const name = extractFileName(normalized);

    // Skip if already tracked from discovery events
    if (alreadyKnownNames.has(name)) continue;

    entries.push({
      name,
      filePath: row.filePath,
      category: categoryFromPath(normalized),
      status: 'read',
    });
  }

  return entries;
}

/**
 * Extract filename from a normalized path.
 */
function extractFileName(normalizedPath: string): string {
  const segments = normalizedPath.split('/');
  return segments[segments.length - 1] || normalizedPath;
}

/**
 * Determine category from a file path based on its directory structure.
 */
function categoryFromPath(normalized: string): ContextFileCategory {
  if (normalized.includes('/instructions/') || normalized.includes('/rules/')) {
    return 'instruction';
  }
  if (normalized.includes('/skills/')) return 'skill';
  if (normalized.includes('/agents/')) return 'agent';
  // Role definitions (e.g. `.agents/roles/reviewer.md`) are agent personas.
  if (/\/\.(?:agents|github|claude|copilot)\/roles\//i.test(normalized)) return 'agent';
  if (normalized.includes('/hooks/')) return 'hook';
  if (normalized.includes('/prompts/')) return 'prompt';

  // Check by file name patterns. The bare-basename set mirrors the context
  // basenames recognized during discovery (AGENTS.md, CLAUDE.md, …) — they are
  // all agent-instruction files, wherever they live.
  const fileName = normalized.split('/').pop() ?? '';
  const lower = fileName.toLowerCase();
  if (
    lower.endsWith('.instructions.md') ||
    lower === 'copilot-instructions.md' ||
    lower === 'claude.md' ||
    lower === 'claude.local.md' ||
    lower === 'agents.md'
  ) {
    return 'instruction';
  }
  if (lower === 'skill.md') return 'skill';
  if (lower.endsWith('.agent.md')) return 'agent';
  if (lower.endsWith('.prompt.md')) return 'prompt';

  return 'unknown';
}
