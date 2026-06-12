/**
 * Estimates per-file token usage within the context window.
 *
 * Primary approach: parse the `gen_ai.system_instructions` attribute to identify
 * file boundaries and estimate char counts per section.
 *
 * Fallback: read files from disk and estimate from file size.
 *
 * Token estimation uses ~4 characters per token (a widely-used heuristic for
 * English text; actual tokenization is model-specific but this is sufficient
 * for relative comparisons).
 *
 * LOCAL-ONLY: content is read on-machine for size estimation only.
 */

import * as fs from 'node:fs';
import type { ContextFileEntry } from './models';

/** Approximate characters per token for estimation. */
const CHARS_PER_TOKEN = 4;

/** Default threshold for flagging oversized files (in estimated tokens). */
export const OVERSIZED_THRESHOLD_TOKENS = 2000;

/**
 * Estimate token usage for each context file. Mutates the entries in-place to
 * set `estimatedTokens` and `charCount`.
 *
 * @param entries - Context file entries to estimate sizes for
 * @param systemInstructionsText - Raw system_instructions text (when available)
 * @param threshold - Token count above which a file is considered oversized
 * @returns The entries with size estimates populated, plus a budget breakdown
 */
export function estimateContextSizes(
  entries: ContextFileEntry[],
  systemInstructionsText: string | undefined,
  totalInputTokens: number,
): {
  entries: ContextFileEntry[];
  totalContextTokens: number;
  contextFileTokens: number;
  otherContextTokens: number;
} {
  // If we have system_instructions, estimate total system prompt size
  const systemPromptChars = systemInstructionsText?.length ?? 0;
  const systemPromptTokens = Math.ceil(systemPromptChars / CHARS_PER_TOKEN);

  let contextFileTokensSum = 0;

  for (const entry of entries) {
    if (entry.status === 'skipped') continue; // Skipped files aren't in context

    // Try to estimate size
    const charCount = estimateFileCharCount(entry, systemInstructionsText);
    if (charCount !== undefined) {
      entry.charCount = charCount;
      entry.estimatedTokens = Math.ceil(charCount / CHARS_PER_TOKEN);
      contextFileTokensSum += entry.estimatedTokens;
    }
  }

  // Use input_tokens from the first LLM call as the total context budget.
  // System instructions are a subset of input_tokens (which also includes
  // the user message, tool definitions, and conversation history).
  const totalContextTokens = totalInputTokens > 0 ? totalInputTokens : systemPromptTokens;
  const otherContextTokens = Math.max(0, totalContextTokens - contextFileTokensSum);

  return {
    entries,
    totalContextTokens,
    contextFileTokens: contextFileTokensSum,
    otherContextTokens,
  };
}

/**
 * Identify files that exceed the oversized threshold.
 */
export function findOversizedFiles(
  entries: readonly ContextFileEntry[],
  threshold: number = OVERSIZED_THRESHOLD_TOKENS,
): ContextFileEntry[] {
  return entries.filter(
    (e) => e.status !== 'skipped' && e.estimatedTokens !== undefined && e.estimatedTokens > threshold,
  );
}

/**
 * Estimate the character count for a single context file entry.
 * Tries system_instructions first, then falls back to disk.
 */
function estimateFileCharCount(
  entry: ContextFileEntry,
  systemInstructionsText: string | undefined,
): number | undefined {
  // Strategy 1: Try to find the file's content in system_instructions
  if (systemInstructionsText) {
    const charCount = estimateFromSystemInstructions(entry.name, systemInstructionsText);
    if (charCount !== undefined) {
      return charCount;
    }
  }

  // Strategy 2: Read from disk
  if (entry.filePath) {
    const charCount = estimateFromDisk(entry.filePath);
    if (charCount !== undefined) {
      return charCount;
    }
  }

  return undefined;
}

/**
 * Try to estimate char count from system_instructions by finding file markers.
 * Looks for common delimiter patterns used by Copilot to separate injected files.
 */
function estimateFromSystemInstructions(
  fileName: string,
  systemInstructions: string,
): number | undefined {
  const baseName = fileName.replace(/\.md$/i, '').replace(/\.(instructions|prompt|agent)$/i, '');

  // Look for sections delimited by file name references
  const patterns = [
    // Pattern: file name appears at a section boundary
    new RegExp(
      `(?:^|\\n)(?:#+\\s*|<!--\\s*|<[^>]*>\\s*)?${escapeRegex(baseName)}[^\\n]*\\n([\\s\\S]*?)(?=\\n(?:#+\\s|<!--\\s|<[^>]*>)|$)`,
      'i',
    ),
  ];

  for (const pattern of patterns) {
    const match = systemInstructions.match(pattern);
    if (match && match[1]) {
      return match[1].length;
    }
  }

  return undefined;
}

/**
 * Estimate char count by reading the file from disk.
 */
function estimateFromDisk(filePath: string): number | undefined {
  try {
    const stat = fs.statSync(filePath);
    return stat.size; // UTF-8 bytes ≈ chars for English text
  } catch {
    return undefined;
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
