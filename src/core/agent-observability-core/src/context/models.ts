/**
 * Context file analysis models — LOCAL-ONLY.
 *
 * These types support the "Context Analysis" tab in the session detail view.
 * They track which customization files (instructions, skills, agents, hooks,
 * prompts) were loaded into the AI context window, detect cross-references
 * between context files, and estimate per-file token usage. All data is
 * derived locally from `span_attributes` and filesystem reads; none is ever
 * uploaded to the cloud sync path.
 */

/**
 * Estimated tokens above which a context file is called oversized and worth
 * splitting up.
 *
 * Lives here rather than beside the estimator that applies it because the
 * threshold is part of the vocabulary — several views label a file by it — while
 * the estimator reads files from disk. A browser-side view that needs only the
 * number can then import it without dragging `node:fs` along.
 */
export const OVERSIZED_THRESHOLD_TOKENS = 2000;

/** Category of a context file based on its discovery source / file type. */
export type ContextFileCategory =
  | 'instruction'
  | 'skill'
  | 'agent'
  | 'hook'
  | 'prompt'
  | 'unknown';

/** How the file ended up (or was excluded from) the context window. */
export type ContextFileStatus = 'applied' | 'skipped' | 'read';

/**
 * One context file detected in a session/agent conversation.
 */
export interface ContextFileEntry {
  /** Short name (e.g. "monorepo-structure", "copilot-instructions.md"). */
  name: string;
  /** Resolved filesystem path when known. */
  filePath?: string;
  /** Classification based on discovery source. */
  category: ContextFileCategory;
  /** Whether the file was applied, skipped, or read (via tool call). */
  status: ContextFileStatus;
  /** Human-readable reason when status is 'skipped' (e.g. "applyTo … did not match"). */
  skipReason?: string;
  /** Estimated token count (≈ charCount / 4). */
  estimatedTokens?: number;
  /** Character count from system_instructions or disk. */
  charCount?: number;
}

/** How one context file references another. */
export type ReferenceType = 'file-path' | 'name-ref' | 'yaml-ref' | 'skill-file-tag';

/**
 * A detected cross-reference from one loaded context file to another.
 */
export interface ContextFileReference {
  /** Name of the file containing the reference. */
  sourceFile: string;
  /** Name of the referenced file (may or may not be loaded). */
  referencedFile: string;
  /** How the reference was detected. */
  referenceType: ReferenceType;
}

/**
 * An expected-but-missing context file: referenced by a loaded file but not
 * present in the context window.
 */
export interface ExpectedMissingFile {
  /** Name of the missing file. */
  name: string;
  /** Which loaded file(s) referenced it. */
  referencedBy: ContextFileReference[];
}

/**
 * Context analysis for a single agent (main thread or a subagent).
 */
export interface AgentContextAnalysis {
  /** Friendly name: "Main Agent" or the subagent name. */
  agentName: string;
  /** Whether this is the main thread or a spawned subagent. */
  kind: 'main' | 'subagent' | 'total';
  /** Context files that were loaded/applied. */
  loadedFiles: ContextFileEntry[];
  /** Files that were expected (referenced by loaded files) but not loaded. */
  expectedMissing: ExpectedMissingFile[];
  /** Estimated total tokens used by the context window (input_tokens of first LLM call). */
  totalContextTokens: number;
  /** Estimated tokens consumed by context files specifically. */
  contextFileTokens: number;
  /** Remaining tokens (total - contextFile = system prompt boilerplate, tools, etc.). */
  otherContextTokens: number;
  /** Files exceeding the oversized threshold. */
  oversizedFiles: ContextFileEntry[];
}

/**
 * Complete context analysis for a session: a total overview plus per-agent
 * breakdowns.
 */
export interface SessionContextAnalysis {
  /** Aggregated overview (union of all agents, deduplicated). */
  total: AgentContextAnalysis;
  /** Per-agent breakdowns: [main, subagent-A, subagent-B, ...]. */
  agents: AgentContextAnalysis[];
  /**
   * Optional provenance caption shown atop the tab. Set by sources whose analysis
   * is best-effort/reconstructed (e.g. the Claude path's current-disk-state
   * caveat); omitted by the point-in-time Copilot path.
   */
  note?: string;
}
