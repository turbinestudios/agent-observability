import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020';
import type { ValidateFunction } from 'ajv/dist/2020';
import { TelemetryDatabase } from '../telemetry/database';
import { copyFixtureToTemp, AGGREGATE_SCHEMA } from '../telemetry/testSupport';
import { buildBatch } from './aggregator';
import { computeDeveloperId } from './pseudonymizer';
import { AggregateBatch } from './models';
import { REPOSITORY_PATTERN } from '../telemetry/repositoryUrl';

/**
 * CRITICAL privacy regression test.
 *
 * Builds a real aggregate batch from the REAL fixture telemetry (via the same
 * getAggregationRows read path the extension uses) and proves the privacy-first
 * contract end-to-end:
 *  (1) the batch validates against the strict shared JSON Schema (ajv) — proving
 *      `additionalProperties: false` is satisfied, so no unexpected/raw field leaks;
 *  (2) no string anywhere contains a known raw-content marker or the redaction
 *      placeholder, no '@' in any repository, and no email-shaped string;
 *  (3) every repository matches the schema repository pattern;
 *  (4) pseudonymousDeveloperId matches ^dev_[0-9a-f]{32}$;
 *  (5) operation is only one of the 4 enum values;
 *  (6) re-building yields an identical batchId and rowKeys (idempotency).
 */

// A deterministic salt + identity so the test does not depend on local git config.
const SALT = 'a'.repeat(64);
const DEV_ID = computeDeveloperId(SALT, 'tester@example.com');

/** The 12 forbidden raw-content attribute keys (schema doc §7) — none may appear. */
const RAW_CONTENT_MARKERS = [
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
  // Borderline / identifying fields that must also never ship.
  'copilot_chat.request.options',
  'copilot_chat.repo.head_branch_name',
  'copilot_chat.repo.head_commit_hash',
  'repositoryBranch',
];

/** The redaction placeholder must never appear (we never ship redacted content). */
const REDACTION_PLACEHOLDER = '[redacted';

/** A loose email shape; no string in the batch may look like an email address. */
const EMAIL_SHAPE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

const OPERATION_ENUM = ['chat', 'execute_tool', 'execute_hook', 'invoke_agent'];

/** Collect every string value reachable in an arbitrary JSON value. */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) {
      collectStrings(v, out);
    }
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      // Keys are also strings emitted in the JSON — check them too.
      out.push(k);
      collectStrings(v, out);
    }
  }
}

describe('aggregate batch privacy contract (real fixture)', () => {
  let batch: AggregateBatch;
  let validate: ValidateFunction;

  beforeAll(() => {
    const copy = copyFixtureToTemp();
    let db: TelemetryDatabase | undefined;
    try {
      db = TelemetryDatabase.open(copy.dbPath);
      const rows = db.getAggregationRows();
      expect(rows.length).toBeGreaterThan(0);
      // Derive the window from the data (as the real preview/sync path does) so
      // every emitted bucketStart falls inside [windowStart, windowEnd).
      const starts = rows.map((r) => r.startTimeMs);
      batch = buildBatch({
        rows,
        pseudonymousDeveloperId: DEV_ID,
        toolVersion: '1.4.2',
        windowStartMs: Math.min(...starts),
        windowEndMs: Math.max(...starts) + 1,
        generatedAtMs: Date.parse('2026-06-02T09:30:00.000Z'),
      });
    } finally {
      db?.close();
      copy.cleanup();
    }

    const schema = JSON.parse(readFileSync(AGGREGATE_SCHEMA, 'utf8')) as object;
    // strict mode catches drift; date-time is a known JSON-Schema format we don't
    // enforce structurally here, so register it as a permissive format rather than
    // relaxing strict mode.
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    ajv.addFormat('date-time', true);
    validate = ajv.compile(schema);
  });

  it('(1) validates against the strict shared JSON Schema (additionalProperties:false satisfied)', () => {
    const ok = validate(batch);
    if (!ok) {
      // Surface ajv errors for diagnosis without printing raw payload content.
      throw new Error(`schema validation failed: ${JSON.stringify(validate.errors)}`);
    }
    expect(ok).toBe(true);
    expect(batch.buckets.length).toBeGreaterThan(0);
  });

  it('(2) contains no raw-content marker, no redaction placeholder, no email-shaped string, no @ in repositories', () => {
    const strings: string[] = [];
    collectStrings(batch, strings);

    for (const s of strings) {
      for (const marker of RAW_CONTENT_MARKERS) {
        expect(s.includes(marker)).toBe(false);
      }
      expect(s.includes(REDACTION_PLACEHOLDER)).toBe(false);
      expect(EMAIL_SHAPE.test(s)).toBe(false);
    }

    for (const b of batch.buckets) {
      expect(b.repository.includes('@')).toBe(false);
    }
    // The developer id itself must not be an email shape and must have no '@'.
    expect(batch.pseudonymousDeveloperId.includes('@')).toBe(false);
    expect(EMAIL_SHAPE.test(batch.pseudonymousDeveloperId)).toBe(false);
  });

  it('(3) every repository matches the schema repository pattern', () => {
    for (const b of batch.buckets) {
      expect(REPOSITORY_PATTERN.test(b.repository)).toBe(true);
    }
  });

  it('(4) pseudonymousDeveloperId matches ^dev_[0-9a-f]{32}$', () => {
    expect(batch.pseudonymousDeveloperId).toMatch(/^dev_[0-9a-f]{32}$/);
  });

  it('(5) operation is only one of the 4 enum values', () => {
    for (const b of batch.buckets) {
      expect(OPERATION_ENUM).toContain(b.operation);
    }
  });

  it('(6) re-building from the same rows yields an identical batchId and rowKeys (idempotent)', () => {
    const copy = copyFixtureToTemp();
    let db: TelemetryDatabase | undefined;
    let rebuilt: AggregateBatch;
    try {
      db = TelemetryDatabase.open(copy.dbPath);
      const rows = db.getAggregationRows();
      const starts = rows.map((r) => r.startTimeMs);
      rebuilt = buildBatch({
        rows,
        pseudonymousDeveloperId: DEV_ID,
        toolVersion: '1.4.2',
        windowStartMs: Math.min(...starts),
        windowEndMs: Math.max(...starts) + 1,
        generatedAtMs: Date.parse('2026-06-02T09:30:00.000Z'),
      });
    } finally {
      db?.close();
      copy.cleanup();
    }

    expect(rebuilt.batchId).toBe(batch.batchId);
    expect(rebuilt.buckets.map((b) => b.rowKey)).toEqual(batch.buckets.map((b) => b.rowKey));
  });
});
