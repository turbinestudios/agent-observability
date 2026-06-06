import { isSafeRegexSource } from '../deviation/contentMatcher';
import {
  CONTENT_PREDICATE_ATTRIBUTE_SET,
  ContentPredicate,
  StepPredicate,
  WorkflowConfig,
  WorkflowDefinition,
  WorkflowStep,
} from '../deviation/models';

/**
 * Pure parser for the `agentObservability.workflows` setting.
 *
 * Kept free of any `vscode` import so it is unit-testable headless (the
 * `Configuration` seam just reads the raw value and hands it here). Parsing is
 * lenient by design: every malformed entry is silently SKIPPED rather than
 * throwing, so a hand-edited settings.json can never break the detail panel.
 * Both the legacy agent-name shape (`expectedSequence`) and the structured
 * predicate DSL (`triggerPredicate` + `steps` + per-step `contentPredicate`) are
 * accepted; the two are independent and may coexist.
 */

/** Minimum allowed deviation/workflow duration in minutes (mirrors package.json). */
export const MIN_SESSION_MINUTES = 1;

/**
 * Raw shape of one workflow as authored in settings.json
 * (`agentObservability.workflows[].workflows[]`). Optional fields default to the
 * documented values when omitted; see {@link parseWorkflowConfigs}.
 */
interface RawWorkflow {
  name?: unknown;
  expectedSequence?: unknown;
  maxDurationMinutes?: unknown;
  sequenceDeviationAlert?: unknown;
  timeoutExceededAlert?: unknown;
  toolUsageAnomalyAlert?: unknown;
  triggerPredicate?: unknown;
  steps?: unknown;
}

/** Raw shape of one repository entry in `agentObservability.workflows`. */
interface RawWorkflowConfig {
  repository?: unknown;
  workflows?: unknown;
}

/**
 * Parse and normalize the raw `agentObservability.workflows` value into
 * {@link WorkflowConfig}s for the local deviation detector.
 *
 * Per-workflow `maxDurationMinutes` falls back to `defaultMaxMs` (already in
 * milliseconds); the three alert flags default to `true` (matching the
 * package.json item defaults). Malformed entries (missing repository/name,
 * non-array workflows) are skipped. Durations are normalized to milliseconds.
 */
export function parseWorkflowConfigs(raw: unknown, defaultMaxMs: number): WorkflowConfig[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const configs: WorkflowConfig[] = [];
  for (const entry of raw as RawWorkflowConfig[]) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const repository = typeof entry.repository === 'string' ? entry.repository.trim() : '';
    if (repository.length === 0 || !Array.isArray(entry.workflows)) {
      continue;
    }

    const workflows: WorkflowDefinition[] = [];
    for (const w of entry.workflows as RawWorkflow[]) {
      const definition = parseWorkflow(w, defaultMaxMs);
      if (definition !== undefined) {
        workflows.push(definition);
      }
    }

    if (workflows.length > 0) {
      configs.push({ repository, workflows });
    }
  }

  return configs;
}

/** Parse one workflow definition, or `undefined` to skip a malformed entry. */
function parseWorkflow(w: RawWorkflow, defaultMaxMs: number): WorkflowDefinition | undefined {
  if (typeof w !== 'object' || w === null) {
    return undefined;
  }
  const name = typeof w.name === 'string' ? w.name.trim() : '';
  if (name.length === 0) {
    return undefined;
  }

  const expectedSequence = Array.isArray(w.expectedSequence)
    ? w.expectedSequence.filter((s): s is string => typeof s === 'string')
    : [];
  const maxDurationMs =
    typeof w.maxDurationMinutes === 'number' && Number.isFinite(w.maxDurationMinutes)
      ? Math.max(MIN_SESSION_MINUTES, Math.floor(w.maxDurationMinutes)) * 60_000
      : defaultMaxMs;

  const triggerPredicate = parseStepPredicate(w.triggerPredicate);
  const steps = Array.isArray(w.steps)
    ? w.steps.map(parseStep).filter((s): s is WorkflowStep => s !== undefined)
    : [];

  const definition: WorkflowDefinition = {
    name,
    expectedSequence,
    maxDurationMs,
    sequenceDeviationAlert:
      typeof w.sequenceDeviationAlert === 'boolean' ? w.sequenceDeviationAlert : true,
    timeoutExceededAlert:
      typeof w.timeoutExceededAlert === 'boolean' ? w.timeoutExceededAlert : true,
    toolUsageAnomalyAlert:
      typeof w.toolUsageAnomalyAlert === 'boolean' ? w.toolUsageAnomalyAlert : true,
  };
  if (triggerPredicate !== undefined) {
    definition.triggerPredicate = triggerPredicate;
  }
  // Attach `steps` only when at least one valid step parsed, so the detector
  // cleanly falls back to the agent-name `expectedSequence` path otherwise.
  if (steps.length > 0) {
    definition.steps = steps;
  }
  return definition;
}

/**
 * Parse a raw {@link StepPredicate}, keeping only well-typed known fields and
 * ignoring everything else. Returns `undefined` when the input is not an object
 * or carries no recognized field (an empty predicate is meaningless as a
 * trigger, and a step requires a non-empty predicate or a content predicate).
 */
export function parseStepPredicate(raw: unknown): StepPredicate | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const predicate: StepPredicate = {};
  if (typeof r.operation === 'string') {
    predicate.operation = r.operation;
  }
  if (typeof r.agentName === 'string') {
    predicate.agentName = r.agentName;
  }
  if (typeof r.agentMode === 'string') {
    predicate.agentMode = r.agentMode;
  }
  if (typeof r.model === 'string') {
    predicate.model = r.model;
  }
  if (typeof r.toolName === 'string') {
    predicate.toolName = r.toolName;
  }
  if (typeof r.success === 'boolean') {
    predicate.success = r.success;
  }
  return Object.keys(predicate).length > 0 ? predicate : undefined;
}

/**
 * Parse a raw {@link ContentPredicate}.
 *
 * Returns the predicate when valid, `undefined` when absent, or the `'invalid'`
 * sentinel when present-but-malformed — most importantly when `attribute` is not
 * in {@link CONTENT_PREDICATE_ATTRIBUTE_SET}. The caller skips the WHOLE step on
 * `'invalid'`, so an unsupported attribute or future-schema key degrades
 * gracefully instead of matching incorrectly. A predicate needs at least one of
 * `contains`/`matches`, and a `matches` regex must pass the ReDoS-safe static
 * subset ({@link isSafeRegexSource}) — a dangerous or uncompilable pattern is
 * rejected here so it never reaches the synchronous match path.
 */
export function parseContentPredicate(raw: unknown): ContentPredicate | undefined | 'invalid' {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) {
    return 'invalid';
  }
  const r = raw as Record<string, unknown>;
  const attribute = typeof r.attribute === 'string' ? r.attribute : '';
  if (!CONTENT_PREDICATE_ATTRIBUTE_SET.has(attribute)) {
    return 'invalid';
  }
  const contains = typeof r.contains === 'string' ? r.contains : undefined;
  const matches = typeof r.matches === 'string' ? r.matches : undefined;
  if (contains === undefined && matches === undefined) {
    return 'invalid';
  }
  if (matches !== undefined && !isSafeRegexSource(matches)) {
    return 'invalid';
  }
  const predicate: ContentPredicate = { attribute };
  if (contains !== undefined) {
    predicate.contains = contains;
  }
  if (matches !== undefined) {
    predicate.matches = matches;
  }
  if (typeof r.negate === 'boolean') {
    predicate.negate = r.negate;
  }
  return predicate;
}

/**
 * Parse one raw {@link WorkflowStep}. Returns `undefined` (skip the step) when it
 * has no name, when it has neither a metadata predicate nor a content predicate,
 * or when its content predicate is present but invalid (e.g. an unsupported
 * attribute). The metadata predicate defaults to the empty (match-any) predicate
 * so a content-only step is valid.
 */
export function parseStep(raw: unknown): WorkflowStep | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name.trim() : '';
  if (name.length === 0) {
    return undefined;
  }

  const contentPredicate = parseContentPredicate(r.contentPredicate);
  if (contentPredicate === 'invalid') {
    return undefined;
  }

  const predicate = parseStepPredicate(r.predicate) ?? {};
  if (Object.keys(predicate).length === 0 && contentPredicate === undefined) {
    return undefined;
  }

  const step: WorkflowStep = { name, predicate };
  if (contentPredicate !== undefined) {
    step.contentPredicate = contentPredicate;
  }
  return step;
}
