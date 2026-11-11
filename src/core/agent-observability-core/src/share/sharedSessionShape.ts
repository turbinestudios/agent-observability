import {
  SHAREABLE_SOURCES,
  SHARED_COST_MODES,
  SHARED_REDACTION_KINDS,
  SHARED_SESSION_KIND,
  SHARED_SESSION_SCHEMA_VERSION,
} from './sharedSessionModels';

/**
 * The shape of a shared-session file, written ONCE as data and used three
 * ways, so they cannot drift apart:
 *
 *  - {@link validateShape} checks an imported file: every object has an
 *    allowlist of keys, any other key is an error, every value has a type.
 *  - {@link pickShape} copies only the allowlisted keys out of a live
 *    `SessionDetail` on export, so a field added to the model later stays
 *    on this machine until someone adds it here on purpose.
 *  - {@link shapeToJsonSchema} produces `schemas/shared-session.schema.json`;
 *    a test regenerates it and fails when the checked-in file differs.
 *
 * Nothing in an imported file is trusted. Numbers must be finite and
 * non-negative, enums are closed, and the renderers HTML-escape every string.
 */

export type Shape =
  | { kind: 'string'; pattern?: string; maxLength?: number }
  | { kind: 'const'; value: string }
  | { kind: 'number' }
  | { kind: 'boolean' }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'array'; items: Shape; maxItems?: number }
  | { kind: 'object'; props: Readonly<Record<string, Prop>> };

export interface Prop {
  shape: Shape;
  optional?: boolean;
}

const str = (maxLength?: number): Shape => ({ kind: 'string', ...(maxLength !== undefined ? { maxLength } : {}) });
const num: Shape = { kind: 'number' };
const bool: Shape = { kind: 'boolean' };
const req = (shape: Shape): Prop => ({ shape });
const opt = (shape: Shape): Prop => ({ shape, optional: true });

const AGENT_MODE: Shape = { kind: 'enum', values: ['default', 'ask', 'edit', 'agent', 'custom'] };
const CREDIT_UNIT: Shape = { kind: 'enum', values: ['ai_credits', 'pru'] };
/** Names, ids and labels; free text (prompts, responses) is unbounded but capped by file size. */
const NAME = str(1024);

const LINES = {
  linesOfCode: req(num),
  linesOfDoc: req(num),
  linesOfCodeRemoved: req(num),
  linesOfDocRemoved: req(num),
};

const TOKENS = {
  inputTokens: req(num),
  outputTokens: req(num),
  cachedTokens: req(num),
};

/** `SessionSummary` minus `titleOriginal` (local rename history) and `externalUrl` (an untrusted link). */
const SUMMARY: Shape = {
  kind: 'object',
  props: {
    sessionId: req(NAME),
    repository: req(NAME),
    startedAtMs: req(num),
    endedAtMs: req(num),
    durationMs: req(num),
    interactionCount: req(num),
    llmCalls: req(num),
    toolCalls: req(num),
    ...TOKENS,
    costMicros: opt(num),
    model: req(NAME),
    agentModes: req({ kind: 'array', items: AGENT_MODE, maxItems: 16 }),
    title: opt(str()),
    titleDerived: opt(bool),
    stateLabel: opt(NAME),
  },
};

const TREE_STATS: Shape = {
  kind: 'object',
  props: {
    modelTurns: req(num),
    toolCalls: req(num),
    ...TOKENS,
    totalTokens: req(num),
    errorCount: req(num),
    aiuNano: req(num),
    costUsdMicros: opt(num),
    creditsNano: opt(num),
    copilotCreditsNano: opt(num),
    creditUnit: opt(CREDIT_UNIT),
    ...LINES,
  },
};

const TIMELINE_ENTRY: Shape = {
  kind: 'object',
  props: {
    timestampMs: req(num),
    operation: req(NAME),
    agentMode: req(AGENT_MODE),
    model: req(NAME),
    toolName: opt(NAME),
    durationMs: req(num),
    success: req(bool),
    userRequest: opt(str()),
  },
};

const TURN: Shape = {
  kind: 'object',
  props: {
    timestampMs: req(num),
    agentMode: req(AGENT_MODE),
    model: req(NAME),
    durationMs: req(num),
    success: req(bool),
    userRequest: opt(str()),
    finalResponse: opt(str()),
    llmCalls: req(num),
    ...TOKENS,
    reasoningTokens: req(num),
    ...LINES,
    events: req({ kind: 'array', items: TIMELINE_ENTRY }),
  },
};

const MODEL_USAGE: Shape = {
  kind: 'object',
  props: {
    model: req(NAME),
    llmCalls: req(num),
    ...TOKENS,
    reasoningTokens: req(num),
    aiuNano: req(num),
    costUsdMicros: opt(num),
    creditsNano: opt(num),
    copilotCreditsNano: opt(num),
  },
};

const AGENT_USAGE: Shape = {
  kind: 'object',
  props: {
    agentName: req(NAME),
    model: req(NAME),
    kind: req({ kind: 'enum', values: ['main', 'subagent'] }),
    llmCalls: req(num),
    ...TOKENS,
    reasoningTokens: req(num),
    aiuNano: req(num),
    costUsdMicros: opt(num),
    creditsNano: opt(num),
    copilotCreditsNano: opt(num),
    creditUnit: opt(CREDIT_UNIT),
    ...LINES,
    runDurationMs: opt(num),
  },
};

const MODEL_TURN_POINT: Shape = {
  kind: 'object',
  props: {
    timestampMs: req(num),
    model: req(NAME),
    ...TOKENS,
    reasoningTokens: req(num),
    ...LINES,
  },
};

/** `SessionDetail`, field for field. */
export const SESSION_DETAIL_SHAPE: Shape = {
  kind: 'object',
  props: {
    summary: req(SUMMARY),
    treeStats: req(TREE_STATS),
    turns: req({ kind: 'array', items: TURN }),
    modelUsage: req({ kind: 'array', items: MODEL_USAGE }),
    agentUsage: req({ kind: 'array', items: AGENT_USAGE }),
    treeModelTurns: req({ kind: 'array', items: MODEL_TURN_POINT }),
  },
};

export const TOOL_VERSION_PATTERN = '^[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$';

/** The whole file. */
export const SHARED_SESSION_SHAPE: Shape = {
  kind: 'object',
  props: {
    kind: req({ kind: 'const', value: SHARED_SESSION_KIND }),
    schemaVersion: req({ kind: 'const', value: SHARED_SESSION_SCHEMA_VERSION }),
    exportedAtMs: req(num),
    toolVersion: req({ kind: 'string', pattern: TOOL_VERSION_PATTERN, maxLength: 64 }),
    origin: req({
      kind: 'object',
      props: {
        source: req({ kind: 'enum', values: SHAREABLE_SOURCES }),
        costMode: req({ kind: 'enum', values: SHARED_COST_MODES }),
      },
    }),
    redactions: req({
      kind: 'object',
      props: {
        count: req(num),
        kinds: req({ kind: 'array', items: { kind: 'enum', values: SHARED_REDACTION_KINDS }, maxItems: 16 }),
      },
    }),
    detail: req(SESSION_DETAIL_SHAPE),
  },
};

/** Stop collecting after this many problems; a broken file says so in the first few. */
const MAX_ERRORS = 20;

/** `[]` when `value` fits `shape`; otherwise one message per problem (capped). */
export function validateShape(value: unknown, shape: Shape, path = ''): string[] {
  const errors: string[] = [];
  walk(value, shape, path, errors);
  return errors.slice(0, MAX_ERRORS);
}

function walk(value: unknown, shape: Shape, path: string, errors: string[]): void {
  if (errors.length >= MAX_ERRORS) {
    return;
  }
  const at = path.length === 0 ? 'file' : path;
  switch (shape.kind) {
    case 'string':
      if (typeof value !== 'string') {
        errors.push(`${at} must be a string.`);
      } else if (shape.maxLength !== undefined && value.length > shape.maxLength) {
        errors.push(`${at} is longer than ${shape.maxLength} characters.`);
      } else if (shape.pattern !== undefined && !new RegExp(shape.pattern, 'u').test(value)) {
        errors.push(`${at} is not in the expected format.`);
      }
      return;
    case 'const':
      if (value !== shape.value) {
        errors.push(`${at} must be '${shape.value}'.`);
      }
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        errors.push(`${at} must be a non-negative number.`);
      }
      return;
    case 'boolean':
      if (typeof value !== 'boolean') {
        errors.push(`${at} must be true or false.`);
      }
      return;
    case 'enum':
      if (typeof value !== 'string' || !shape.values.includes(value)) {
        errors.push(`${at} must be one of ${shape.values.join(', ')}.`);
      }
      return;
    case 'array':
      if (!Array.isArray(value)) {
        errors.push(`${at} must be an array.`);
        return;
      }
      if (shape.maxItems !== undefined && value.length > shape.maxItems) {
        errors.push(`${at} has more than ${shape.maxItems} items.`);
        return;
      }
      value.forEach((item, i) => walk(item, shape.items, `${path}[${i}]`, errors));
      return;
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        errors.push(`${at} must be an object.`);
        return;
      }
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (!Object.prototype.hasOwnProperty.call(shape.props, key)) {
          errors.push(`${join(path, key)} is not allowed.`);
        }
      }
      for (const [key, prop] of Object.entries(shape.props)) {
        const child = record[key];
        if (child === undefined) {
          if (prop.optional !== true) {
            errors.push(`${join(path, key)} is required.`);
          }
          continue;
        }
        walk(child, prop.shape, join(path, key), errors);
      }
      return;
    }
  }
}

function join(path: string, key: string): string {
  return path.length === 0 ? key : `${path}.${key}`;
}

/**
 * A deep copy of `value` holding ONLY the keys `shape` allows. Values are
 * copied as they are (the caller validates the result); `undefined` optional
 * fields are left out so the JSON carries no `null`s.
 */
export function pickShape(value: unknown, shape: Shape): unknown {
  switch (shape.kind) {
    case 'array':
      return Array.isArray(value) ? value.map((item) => pickShape(item, shape.items)) : value;
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return value;
      }
      const record = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, prop] of Object.entries(shape.props)) {
        const child = record[key];
        if (child !== undefined) {
          out[key] = pickShape(child, prop.shape);
        }
      }
      return out;
    }
    default:
      return value;
  }
}

/** The JSON Schema (draft 2020-12) for `shape`, as checked in under `schemas/`. */
export function shapeToJsonSchema(shape: Shape): Record<string, unknown> {
  switch (shape.kind) {
    case 'string':
      return {
        type: 'string',
        ...(shape.maxLength !== undefined ? { maxLength: shape.maxLength } : {}),
        ...(shape.pattern !== undefined ? { pattern: shape.pattern } : {}),
      };
    case 'const':
      return { const: shape.value };
    case 'number':
      return { type: 'number', minimum: 0 };
    case 'boolean':
      return { type: 'boolean' };
    case 'enum':
      return { enum: [...shape.values] };
    case 'array':
      return {
        type: 'array',
        items: shapeToJsonSchema(shape.items),
        ...(shape.maxItems !== undefined ? { maxItems: shape.maxItems } : {}),
      };
    case 'object': {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, prop] of Object.entries(shape.props)) {
        properties[key] = shapeToJsonSchema(prop.shape);
        if (prop.optional !== true) {
          required.push(key);
        }
      }
      return { type: 'object', additionalProperties: false, required, properties };
    }
  }
}

/** The checked-in schema file's content, header included. */
export function sharedSessionJsonSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://turbine.dev/schemas/shared-session.schema.json',
    title: 'Agent Observability Shared Session (v1)',
    description:
      'One session a user exported to a file to share with a colleague. Carries raw content (prompts and responses, secrets redacted best-effort). Generated from src/core/agent-observability-core/src/share/sharedSessionShape.ts; do not edit by hand.',
    ...shapeToJsonSchema(SHARED_SESSION_SHAPE),
  };
}
