import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020';
import type { ValidateFunction } from 'ajv/dist/2020';
import { AGGREGATE_SCHEMA, CONTEXT_INSIGHTS_SCHEMA } from '../telemetry/testSupport';
import { schemaVersionOf, validateAggregateBatch, validateContextInsightsBatch } from './batchValidators';
import { buildFixtureShard, clone } from '../team/teamShardFixture';

/**
 * Parity between the TS ports of the server validators and the JSON schemas:
 * what one accepts the other accepts, and every negative is refused by both.
 * This is the test that catches a forgotten key allowlist in the port.
 */

type Json = Record<string, unknown>;

function compile(file: string): ValidateFunction {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  ajv.addFormat('date-time', true);
  return ajv.compile(JSON.parse(readFileSync(file, 'utf8')) as object);
}

/** Apply a mutation to a clone and return it as loose JSON. */
function mutate<T>(value: T, change: (copy: Json) => void): Json {
  const copy = clone(value) as unknown as Json;
  change(copy);
  return copy;
}

describe('validateAggregateBatch ↔ aggregate-batch.schema.json', () => {
  let validateSchema: ValidateFunction;
  let batch: Json;

  beforeAll(() => {
    validateSchema = compile(AGGREGATE_SCHEMA);
    batch = clone(buildFixtureShard().aggregate) as unknown as Json;
  });

  it('accepts the fixture on both sides', () => {
    expect(validateAggregateBatch(batch)).toEqual([]);
    expect(validateSchema(batch)).toBe(true);
  });

  const negatives: [string, (copy: Json) => void][] = [
    ['unknown envelope key', (c) => void (c.extra = 1)],
    ['unknown window key', (c) => void ((c.window as Json).tz = 'UTC')],
    ['unknown bucket key', (c) => void ((c.buckets as Json[])[0].prompt = 'hi')],
    ['unknown histogram key', (c) => void (((c.buckets as Json[])[0].latencyHistogram as Json).p95 = 1)],
    ['repository with @', (c) => void ((c.buckets as Json[])[0].repository = 'https://u:t@github.com/a/b')],
    ['histogram with 8 counts', (c) => void (((c.buckets as Json[])[0].latencyHistogram as Json).counts = [0, 0, 0, 0, 0, 0, 0, 0])],
    ['bad schemaVersion', (c) => void (c.schemaVersion = '2.0')],
    ['bad developer id', (c) => void (c.pseudonymousDeveloperId = 'alice@example.com')],
    ['negative tokens', (c) => void ((c.buckets as Json[])[0].inputTokens = -1)],
    ['bad operation', (c) => void ((c.buckets as Json[])[0].operation = 'delete_everything')],
    ['bad bucket duration', (c) => void ((c.buckets as Json[])[0].bucketDurationSeconds = 60)],
  ];

  for (const [name, change] of negatives) {
    it(`rejects ${name} on both sides`, () => {
      const broken = mutate(batch, change);
      expect(validateAggregateBatch(broken).length).toBeGreaterThan(0);
      expect(validateSchema(broken)).toBe(false);
    });
  }

  // Rules the JSON Schema cannot express (free-text fields with a closed set
  // enforced server-side, and cross-field arithmetic). The schema accepts them;
  // the validator refuses them — this is the "defense in depth" it adds on
  // top of the schema.
  const serverOnly: [string, (copy: Json) => void, string][] = [
    ['bad agentMode', (c) => void ((c.buckets as Json[])[0].agentMode = 'my-mode'), 'agentMode must be one of'],
    [
      'success + error > interactions',
      (c) => {
        const b = (c.buckets as Json[])[0];
        b.interactionCount = 1;
        b.successCount = 1;
        b.errorCount = 1;
      },
      'successCount + errorCount must be <= interactionCount',
    ],
    ['tool name with a path', (c) => void ((c.buckets as Json[])[0].toolName = 'C:/tools/x'), 'toolName, when present, must be an identifier'],
  ];

  for (const [name, change, message] of serverOnly) {
    it(`rejects ${name} like the server, where the schema alone cannot`, () => {
      const broken = mutate(batch, change);
      expect(validateSchema(broken)).toBe(true);
      expect(validateAggregateBatch(broken).join(' ')).toContain(message);
    });
  }

  it('rejects an inverted window on both sides', () => {
    // The schema cannot compare the two dates; the validator must.
    const broken = mutate(batch, (c) => {
      const w = c.window as Json;
      [w.start, w.end] = [w.end, w.start];
    });
    expect(validateAggregateBatch(broken)).toContain('window.end must be greater than window.start.');
  });
});

describe('validateContextInsightsBatch ↔ context-insights-batch.schema.json', () => {
  let validateSchema: ValidateFunction;
  let batch: Json;

  beforeAll(() => {
    validateSchema = compile(CONTEXT_INSIGHTS_SCHEMA);
    batch = clone(buildFixtureShard().contextInsights) as unknown as Json;
  });

  it('accepts the fixture on both sides', () => {
    expect(validateContextInsightsBatch(batch)).toEqual([]);
    expect(validateSchema(batch)).toBe(true);
  });

  const negatives: [string, (copy: Json) => void][] = [
    ['unknown envelope key', (c) => void (c.notes = 'x')],
    ['unknown row key', (c) => void ((c.rows as Json[])[0].content = 'file body')],
    [
      'unknown skipReasonCounts key',
      (c) => {
        const row = (c.rows as Json[]).find((r) => r.skipReasonCounts !== undefined) as Json;
        (row.skipReasonCounts as Json).because = 1;
      },
    ],
    ['absolute contextFile', (c) => void ((c.rows as Json[])[0].contextFile = '/home/jdoe/AGENTS.md')],
    ['drive-letter contextFile', (c) => void ((c.rows as Json[])[0].contextFile = 'C:/repo/AGENTS.md')],
    ['traversal contextFile', (c) => void ((c.rows as Json[])[0].contextFile = '../AGENTS.md')],
    ['non-customization contextFile', (c) => void ((c.rows as Json[])[0].contextFile = 'src/index.ts')],
    ['repository with whitespace', (c) => void ((c.rows as Json[])[0].repository = 'https://github.com/a/b c')],
    ['bad category', (c) => void ((c.rows as Json[])[0].category = 'unknown')],
    ['negative applied', (c) => void ((c.rows as Json[])[0].appliedCount = -2)],
  ];

  for (const [name, change] of negatives) {
    it(`rejects ${name} on both sides`, () => {
      const broken = mutate(batch, change);
      expect(validateContextInsightsBatch(broken).length).toBeGreaterThan(0);
      expect(validateSchema(broken)).toBe(false);
    });
  }
});

describe('validateContextInsightsBatch server-only rules', () => {
  it('rejects a skipReasonCounts sum above skippedCount, which the schema cannot express', () => {
    const batch = clone(buildFixtureShard().contextInsights) as unknown as Json;
    const broken = mutate(batch, (c) => {
      const row = (c.rows as Json[]).find((r) => r.skipReasonCounts !== undefined) as Json;
      (row.skipReasonCounts as Json).other = 99;
    });
    expect(compile(CONTEXT_INSIGHTS_SCHEMA)(broken)).toBe(true);
    expect(validateContextInsightsBatch(broken)).toContain('rows[0].skipReasonCounts must sum to <= skippedCount.');
  });
});

describe('schemaVersionOf', () => {
  it('reads a string version and nothing else', () => {
    expect(schemaVersionOf({ schemaVersion: '9.0' })).toBe('9.0');
    expect(schemaVersionOf({ schemaVersion: 9 })).toBeUndefined();
    expect(schemaVersionOf('1.0')).toBeUndefined();
    expect(schemaVersionOf(null)).toBeUndefined();
  });
});
