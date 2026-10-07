/**
 * Workflow-deviation config and result shapes.
 *
 * Originally a TypeScript port of the retired cloud dashboard's C# workflow
 * models (the "Mirrors C# …" notes below name the originals). It has since
 * grown a structured predicate DSL ({@link StepPredicate}, {@link WorkflowStep},
 * {@link ContentPredicate}) that gives the local detector the expressive power
 * of the old KQL-based model, without KQL.
 *
 * Two tiers of matching:
 * - METADATA ({@link StepPredicate}) over the safe {@link ../telemetry/models.Interaction}
 *   projection — runs anywhere, never touches content.
 * - CONTENT ({@link ContentPredicate}) over raw `span_attributes` values — strictly
 *   LOCAL-ONLY; matched text never enters a {@link WorkflowDeviation}, and any
 *   deviation a content predicate contributes to is flagged {@link WorkflowDeviation.contentDerived}.
 *
 * Durations are expressed in milliseconds (the local model's native unit)
 * rather than the C# `TimeSpan`, but the thresholds are identical.
 */

/** Kinds of deviation the detector can emit. Mirrors C# `DeviationType`. */
export enum DeviationType {
  SequenceDeviation = 'SequenceDeviation',
  TimeoutExceeded = 'TimeoutExceeded',
  MissingSteps = 'MissingSteps',
  ToolUsageAnomaly = 'ToolUsageAnomaly',
}

/**
 * A structured filter over the SAFE {@link ../telemetry/models.Interaction}
 * metadata fields — the local equivalent of a cloud `WorkflowStep.KqlQuery`
 * expressed declaratively rather than as KQL.
 *
 * Every field is optional; an absent field matches ANY value. String fields
 * compare case-insensitively (matching the detector's existing
 * OrdinalIgnoreCase agent-name semantics); `success` compares exactly. A
 * predicate with no fields set matches every interaction.
 *
 * This tier touches ONLY safe metadata — never raw content. Content matching is
 * the separate, local-only {@link ContentPredicate}.
 */
export interface StepPredicate {
  /** Match `Interaction.operation` (e.g. `chat`, `execute_tool`). */
  operation?: string;
  /** Match `Interaction.agentName`. */
  agentName?: string;
  /** Match `Interaction.agentMode` (e.g. `agent`, `ask`, `edit`). */
  agentMode?: string;
  /** Match `Interaction.model`. */
  model?: string;
  /** Match `Interaction.toolName`; interactions without a tool never match. */
  toolName?: string;
  /** Match `Interaction.success` exactly. */
  success?: boolean;
}

/**
 * The `span_attributes` keys a {@link ContentPredicate} is permitted to target.
 *
 * This is exactly the forbidden-to-sync raw-content set — the keys
 * `aggregate/privacy.test.ts` (`RAW_CONTENT_MARKERS`) proves never reach the
 * cloud batch — plus the safe `copilot_chat.mode_name` metadata key (whose RAW
 * value carries the un-collapsed custom mode name and so is also local-only).
 * Content predicates therefore operate ONLY over local-only content; any other
 * attribute is rejected at parse time in `configuration.ts`.
 *
 * `repositoryBranch` (present in `RAW_CONTENT_MARKERS` as a defensive
 * string-search marker) is deliberately omitted: it is an aggregate OUTPUT field
 * name, not a `span_attributes` key, so it could never match a row.
 */
export const CONTENT_PREDICATE_ATTRIBUTES: readonly string[] = [
  'copilot_chat.user_request',
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.system_instructions',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
  'gen_ai.tool.definitions',
  'gen_ai.tool.description',
  'copilot_chat.reasoning_content',
  'copilot_chat.hook_input',
  'copilot_chat.hook_output',
  'copilot_chat.hook_command',
  'copilot_chat.request.options',
  'copilot_chat.repo.head_branch_name',
  'copilot_chat.repo.head_commit_hash',
  'copilot_chat.mode_name',
];

/** O(1) membership form of {@link CONTENT_PREDICATE_ATTRIBUTES}. */
export const CONTENT_PREDICATE_ATTRIBUTE_SET: ReadonlySet<string> = new Set(
  CONTENT_PREDICATE_ATTRIBUTES,
);

/**
 * A filter over a single raw `span_attributes` value — the local equivalent of
 * a cloud `WorkflowStep.KqlQuery` that checks log CONTENT.
 *
 * PRIVACY: evaluated only on the local detection path. The matched text is never
 * copied into a {@link WorkflowDeviation}; only the boolean outcome is. Any
 * deviation a content predicate contributes to is flagged
 * {@link WorkflowDeviation.contentDerived}, which sync/export paths MUST exclude.
 */
export interface ContentPredicate {
  /** Attribute key to read; MUST be one of {@link CONTENT_PREDICATE_ATTRIBUTES}. */
  attribute: string;
  /** Case-insensitive substring match (preferred over {@link matches}). */
  contains?: string;
  /** Regex pattern string (guarded for ReDoS; see {@link ../deviation/contentMatcher}). */
  matches?: string;
  /** Invert the match outcome. */
  negate?: boolean;
}

/**
 * One ordered step of a structured workflow. The local analog of a cloud
 * `WorkflowStep`: a {@link StepPredicate} over safe metadata, optionally narrowed
 * by a local-only {@link ContentPredicate}. A step is "satisfied" when at least
 * one interaction matches the metadata predicate AND (when present) the content
 * predicate.
 */
export interface WorkflowStep {
  /** Step name, surfaced in deviation descriptions (never any matched content). */
  name: string;
  /** Required metadata predicate (may be empty to match any interaction). */
  predicate: StepPredicate;
  /** Optional LOCAL-ONLY content predicate over a raw `span_attributes` value. */
  contentPredicate?: ContentPredicate;
}

/**
 * One expected workflow within a repository. Mirrors C# `WorkflowDefinition`,
 * with `MaxDuration` (a `TimeSpan`) expressed as `maxDurationMs`, extended with
 * the structured predicate DSL.
 */
export interface WorkflowDefinition {
  /** Human-readable workflow name (e.g. `feature-development`, `default`). */
  name: string;
  /** Expected ordered agent names. Empty disables sequence/missing checks. */
  expectedSequence: string[];
  /** Session duration / inter-interaction gap threshold, in milliseconds. */
  maxDurationMs: number;
  /** Emit a {@link DeviationType.SequenceDeviation} when the order is wrong. */
  sequenceDeviationAlert: boolean;
  /** Emit a {@link DeviationType.TimeoutExceeded} when the session runs long. */
  timeoutExceededAlert: boolean;
  /** Emit a {@link DeviationType.ToolUsageAnomaly} on a high failure rate. */
  toolUsageAnomalyAlert: boolean;
  /**
   * Optional metadata trigger predicate: a pure applicability GATE. The workflow
   * applies to a user-request turn iff at least one of the turn's interactions
   * matches it, and the trigger NEVER filters the analyzed interactions — every
   * check runs over the whole turn, so the trigger may be narrower than (or
   * disjoint from) the step predicates. Absent → applies to every turn.
   */
  triggerPredicate?: StepPredicate;
  /**
   * Optional LOCAL-ONLY content gate on the trigger: the workflow applies to a
   * turn only when the turn's anchor (the user-request span) content matches this
   * predicate, in ADDITION to any {@link triggerPredicate}. Lets relevance key on
   * what the request is ABOUT (e.g. `copilot_chat.user_request` contains "migrate
   * the database"), which metadata alone cannot express.
   *
   * Evaluated only on-machine, and every deviation from a content-triggered
   * workflow is flagged {@link WorkflowDeviation.contentDerived}, so it is
   * local-only by construction and never eligible for sync (sync-adjacent
   * consumers exclude content-derived deviations).
   */
  triggerContentPredicate?: ContentPredicate;
  /**
   * Optional ordered structured steps. When present and non-empty, predicate-based
   * matching supersedes {@link expectedSequence} for the sequence/missing checks.
   * Absent → the agent-name {@link expectedSequence} path is used.
   */
  steps?: WorkflowStep[];
}

/** All expected workflows for one repository. Mirrors C# `WorkflowConfig`. */
export interface WorkflowConfig {
  /** Sanitized repository these workflows apply to. */
  repository: string;
  /** The workflows to check this repository's interactions against. */
  workflows: WorkflowDefinition[];
}

/** A detected deviation. Mirrors C# `WorkflowDeviation`. */
export interface WorkflowDeviation {
  /** Sanitized repository the deviation was found in. */
  repository: string;
  /** Name of the workflow whose rules flagged this. */
  workflowName: string;
  /** Which check fired. */
  type: DeviationType;
  /** Human-readable explanation (parity with the cloud description text). */
  description: string;
  /** When the deviation was detected (epoch ms). */
  detectedAt: number;
  /** Distinct actual agent sequence, when relevant. */
  actualSequence?: string[];
  /** Configured expected sequence, when relevant. */
  expectedSequence?: string[];
  /** Observed session duration in ms (TimeoutExceeded only). */
  actualDurationMs?: number;
  /** Configured maximum duration in ms (TimeoutExceeded only). */
  maxDurationMs?: number;
  /**
   * `true` when a {@link ContentPredicate} contributed to this deviation. Such
   * deviations are LOCAL-ONLY by construction: the matched text is never stored
   * on this object (only the boolean outcome is), and any sync/export path MUST
   * exclude them. Deviations never cross the network today; this flag makes that
   * boundary explicit and future-proof. Absent/`false` for metadata-only checks.
   */
  contentDerived?: boolean;
}
