import { parseWorkflowConfigs } from '../../config/workflowParsing';
import { extractFencedBlock } from './fenced';

/**
 * Pure prompt construction + output validation for the "Generate workflows" task.
 *
 * The provider gathers the project's context files (an IO concern, in
 * `projectContext.ts`) and passes the digest here; the preamble, fenced-block
 * extraction, validation, and the merge applied before writing settings are all
 * pure and unit-tested. Validation reuses the PRODUCTION parser
 * ({@link parseWorkflowConfigs}) so "valid" means exactly what the local
 * deviation detector accepts.
 */

/** The fence tag the assistant is asked to use for generated workflows. */
export const WORKFLOWS_FENCE_LANG = 'ao-workflows';

/** Assemble the grounding preamble for the workflow-generation request. */
export function buildWorkflowGenPreamble(contextText: string, digest: string): string {
  return [
    contextText,
    '',
    digest,
    '',
    '## Task',
    'Propose expected workflow definitions for `agentObservability.workflows` for the repository above,',
    'derived from the project context files shown above — the agents they declare, the order those',
    'agents run in, and the tools they use. Use the exact `repository` string provided and the agent/',
    'tool names that appear in the context files; do not invent repositories, agents, or tools. If NO',
    'context files were provided, say so plainly and do NOT fabricate a workflow. Otherwise emit EXACTLY',
    'ONE fenced code block tagged `' + WORKFLOWS_FENCE_LANG + '` containing a JSON array (the value of',
    '`agentObservability.workflows`) and nothing the user must fix by hand. Keep predicates',
    'metadata-only. A short sentence before the block is fine.',
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
