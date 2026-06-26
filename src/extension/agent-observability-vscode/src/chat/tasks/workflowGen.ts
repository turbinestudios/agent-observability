import { parseWorkflowConfigs } from '../../config/workflowParsing';
import { extractFencedBlock } from './fenced';

/**
 * Pure prompt construction + output validation for the "Generate workflows" task.
 *
 * The provider gathers the telemetry facts (an IO concern) and passes them here;
 * everything in this module — digest text, preamble, fenced-block extraction,
 * validation, and the merge applied before writing settings — is pure and
 * unit-tested. Validation reuses the PRODUCTION parser
 * ({@link parseWorkflowConfigs}) so "valid" means exactly what the local
 * deviation detector accepts.
 */

/** The fence tag the assistant is asked to use for generated workflows. */
export const WORKFLOWS_FENCE_LANG = 'ao-workflows';

/** Distilled, safe facts about one repository's activity, for grounding the model. */
export interface RepoWorkflowFacts {
  repository: string;
  sessionCount: number;
  agents: string[];
  tools: string[];
  operations: string[];
  models: string[];
  /** Typical session duration in ms (e.g. median). */
  typicalDurationMs: number;
  /** Longest session duration in ms. */
  maxDurationMs: number;
}

/** Build a compact, safe-metadata digest of the observed repositories. */
export function buildWorkflowDigest(facts: readonly RepoWorkflowFacts[]): string {
  if (facts.length === 0) {
    return 'No repository activity was found in the local telemetry.';
  }
  const lines = facts.map((f) => {
    const parts = [
      `- **${f.repository}** — ${f.sessionCount} session(s)`,
      `agents: ${list(f.agents)}`,
      `tools: ${list(f.tools)}`,
      `operations: ${list(f.operations)}`,
      `models: ${list(f.models)}`,
      `typical duration ~${seconds(f.typicalDurationMs)} (max ${seconds(f.maxDurationMs)})`,
    ];
    return parts.join('; ');
  });
  return `## Observed repositories\n${lines.join('\n')}`;
}

/** Assemble the grounding preamble for the workflow-generation request. */
export function buildWorkflowGenPreamble(contextText: string, digest: string): string {
  return [
    contextText,
    '',
    digest,
    '',
    '## Task',
    'Propose expected workflow definitions for `agentObservability.workflows` based ONLY on the',
    'observed repositories above. Use the exact repository strings and the observed agent/tool names —',
    'do not invent any. Emit EXACTLY ONE fenced code block tagged `' + WORKFLOWS_FENCE_LANG + '`',
    'containing a JSON array (the value of `agentObservability.workflows`) and nothing the user must',
    'fix by hand. Keep predicates metadata-only. A short sentence before the block is fine.',
  ].join('\n');
}

/** Outcome of validating the model's generated workflow JSON. */
export type WorkflowValidation =
  | { ok: true; value: unknown[] }
  | { ok: false; reason: string };

/**
 * Validate the assistant's response: pull the fenced block, then validate its
 * JSON. Returns the RAW parsed array (the settings-shaped value to persist).
 */
export function validateWorkflowResponse(response: string, defaultMaxMs: number): WorkflowValidation {
  const block = extractFencedBlock(response, [WORKFLOWS_FENCE_LANG]);
  if (block === undefined) {
    return { ok: false, reason: 'The response contained no JSON code block.' };
  }
  return validateWorkflowsJson(block, defaultMaxMs);
}

/**
 * Validate raw workflow JSON text (a `{ repository, workflows }[]` array). Runs
 * it through the production {@link parseWorkflowConfigs}, so success means
 * exactly what the local deviation detector accepts; returns the RAW array to
 * persist only when at least one workflow config survives parsing. Used both on
 * the response path and when applying the block the webview sends back.
 */
export function validateWorkflowsJson(jsonText: string, defaultMaxMs: number): WorkflowValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { ok: false, reason: 'The generated configuration was not valid JSON.' };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: 'Expected a JSON array of { repository, workflows } entries.' };
  }
  if (parseWorkflowConfigs(parsed, defaultMaxMs).length === 0) {
    return { ok: false, reason: 'No valid workflow entries were produced.' };
  }
  return { ok: true, value: parsed };
}

/**
 * Merge generated repository entries into the existing `agentObservability.workflows`
 * value: an entry whose `repository` matches an existing one REPLACES it; entries
 * for new repositories are appended; all other existing repositories are kept.
 */
export function mergeWorkflowsByRepository(existing: unknown, generated: readonly unknown[]): unknown[] {
  const result: unknown[] = Array.isArray(existing) ? [...existing] : [];
  for (const entry of generated) {
    const repo = repositoryOf(entry);
    if (repo === undefined) {
      result.push(entry);
      continue;
    }
    const idx = result.findIndex((e) => repositoryOf(e) === repo);
    if (idx >= 0) {
      result[idx] = entry;
    } else {
      result.push(entry);
    }
  }
  return result;
}

/** Read a trimmed `repository` string from a raw entry, or `undefined`. */
function repositoryOf(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null) {
    return undefined;
  }
  const repo = (entry as { repository?: unknown }).repository;
  return typeof repo === 'string' && repo.trim().length > 0 ? repo.trim() : undefined;
}

/** Join a distinct list for the digest, capping the count. */
function list(values: readonly string[]): string {
  if (values.length === 0) {
    return 'none';
  }
  const capped = values.slice(0, 12);
  const suffix = values.length > capped.length ? `, …(+${values.length - capped.length})` : '';
  return capped.join(', ') + suffix;
}

/** Human-readable seconds for a millisecond duration. */
function seconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}
