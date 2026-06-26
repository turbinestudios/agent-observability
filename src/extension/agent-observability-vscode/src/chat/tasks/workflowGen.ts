import { parseWorkflowConfigs } from '../../config/workflowParsing';
import type { WorkflowConfig } from '../../deviation/models';
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
    'context files were provided, say so plainly and do NOT fabricate a workflow.',
    '',
    'Scope every workflow with a PRECISE `triggerPredicate` (metadata only) so it applies to ONLY the',
    'sessions it describes. The detector keeps just the interactions that match the trigger and runs',
    'every check over that subset, so a trigger that matches every session turns ordinary work into',
    'false deviations. NEVER scope by `agentMode` alone (e.g. `{"agentMode":"agent"}`) and never leave',
    'the trigger empty — that matches everything, and a custom chat mode reports as `agentMode:"custom"`',
    'regardless, so `agentMode` cannot tell one workflow from another. Instead pick a discriminator that',
    'is real, shared by the whole flow, and absent from unrelated sessions: `operation` (use',
    '`"invoke_agent"` for a flow that spawns sub-agents), a signature `toolName`, a `model` the agent',
    'file pins, or a spawned sub-agent `agentName`. The trigger must be a SUPERSET of the steps — never',
    'narrower than any step, or that step can never match and is reported missing. If the context files',
    'expose no metadata that separates this workflow from others, prefer ONE repo-wide workflow over a',
    'vague trigger rather than guessing.',
    '',
    'Emit EXACTLY ONE fenced code block tagged `' + WORKFLOWS_FENCE_LANG + '` containing a JSON array',
    '(the value of `agentObservability.workflows`) and nothing the user must fix by hand. A short',
    'sentence before the block is fine.',
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
  const configs = parseWorkflowConfigs(parsed, defaultMaxMs);
  if (configs.length === 0) {
    return { ok: false, reason: 'No valid workflow entries were produced.' };
  }
  const tooBroad = findTooBroadTrigger(configs);
  if (tooBroad !== undefined) {
    return {
      ok: false,
      reason:
        `Workflow “${tooBroad}” has a trigger predicate that matches nearly every session, so it ` +
        `would flag ordinary work as a deviation. Scope it with operation (e.g. "invoke_agent"), ` +
        `toolName, model, or a sub-agent agentName — not agentMode alone.`,
    };
  }
  return { ok: true, value: parsed };
}

/**
 * The first workflow whose `triggerPredicate` is present but too broad to scope
 * anything: it sets only non-discriminating fields (`agentMode` / `success`) and
 * none of `operation` / `agentName` / `toolName` / `model`. Because the trigger
 * is the sole applicability gate AND scopes the interactions every check runs
 * over, such a trigger matches (nearly) every session and turns ordinary work
 * into false deviations — the exact failure a vague `{"agentMode":"agent"}`
 * causes. Returns the offending workflow name, or `undefined` when every present
 * trigger carries a real discriminator (absent triggers are left to the
 * backward-compatible whole-session default).
 */
function findTooBroadTrigger(configs: readonly WorkflowConfig[]): string | undefined {
  for (const config of configs) {
    for (const workflow of config.workflows) {
      // A content trigger (intent-based relevance) is itself a real discriminator.
      if (workflow.triggerContentPredicate !== undefined) {
        continue;
      }
      const trigger = workflow.triggerPredicate;
      if (trigger === undefined) {
        continue;
      }
      const hasDiscriminator =
        trigger.operation !== undefined ||
        trigger.agentName !== undefined ||
        trigger.toolName !== undefined ||
        trigger.model !== undefined;
      if (!hasDiscriminator) {
        return workflow.name;
      }
    }
  }
  return undefined;
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
