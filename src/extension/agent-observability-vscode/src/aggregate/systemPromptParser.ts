/**
 * System-prompt context-file parser — PRODUCER-SIDE, pure + headless.
 *
 * GitHub Copilot embeds the customization files it surfaces for a turn inside the
 * `gen_ai.system_instructions` blob as `<file>ABSOLUTE_PATH</file>` elements (one
 * per listed instruction / skill / prompt / agent). This module extracts those
 * paths so the context-insights extractor can attribute per-session customization
 * usage WITHOUT depending on Copilot's discovery `core_event` spans (which the
 * otlp-http live-updates stream never emits).
 *
 * It reads only the already-captured LOCAL prompt text and returns file
 * identities; it never uploads content. Resolution to a safe, repo-relative,
 * allowlisted path (and the dropping of out-of-workspace files) is done downstream
 * by {@link resolveRepoRelativePath} — this module only enumerates candidates that
 * look like customization files by name.
 *
 * Imports only a sibling filter (no `node:fs` / `vscode`), so it runs headless
 * under vitest with plain string inputs.
 */

import { isCustomizationFileName } from './customizationFilter';

/** One customization file referenced by a system prompt. */
export interface SystemPromptContextFile {
  /** Base file name (e.g. `security.instructions.md`). */
  name: string;
  /** The raw path exactly as it appeared inside the `<file>` element. */
  filePath: string;
}

/** Matches `<file>…</file>` elements; the capture is the inner path text. */
const FILE_ELEMENT_PATTERN = /<file>\s*([^<>]+?)\s*<\/file>/gi;

/**
 * Extract the distinct customization files referenced as `<file>…</file>` in one
 * system-prompt blob. Non-customization `<file>` entries (arbitrary attached
 * source files, docs, etc.) are filtered out by the allowlist; the survivors are
 * deduped by their normalized path so a file listed twice yields one entry.
 *
 * @param systemInstructionsText the raw `gen_ai.system_instructions` value
 * @returns customization-file candidates for downstream repo-relative resolution
 */
export function parseSystemPromptContextFiles(
  systemInstructionsText: string | undefined,
): SystemPromptContextFile[] {
  if (systemInstructionsText === undefined || systemInstructionsText.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const results: SystemPromptContextFile[] = [];

  for (const match of systemInstructionsText.matchAll(FILE_ELEMENT_PATTERN)) {
    const raw = match[1]?.trim();
    if (raw === undefined || raw.length === 0) {
      continue;
    }
    const name = baseName(raw);
    if (!isCustomizationFileName(name)) {
      continue;
    }
    const dedupeKey = raw.replace(/\\/g, '/').toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    results.push({ name, filePath: raw });
  }

  return results;
}

/** Last path segment, treating both `/` and `\` as separators. */
function baseName(p: string): string {
  const segments = p.replace(/\\/g, '/').split('/');
  return segments[segments.length - 1] ?? p;
}
