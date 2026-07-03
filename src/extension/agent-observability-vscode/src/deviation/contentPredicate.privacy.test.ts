import { describe, it, expect } from 'vitest';
import { ContentLookup, WorkflowDeviationDetector } from './deviationDetector';
import { DeviationType, WorkflowConfig } from './models';
import { Interaction } from '../telemetry/models';
import { buildBatch } from '../aggregate/aggregator';
import { AggregationRow } from '../aggregate/aggregator';

/**
 * Privacy contract for CONTENT predicates (companion to
 * `aggregate/privacy.test.ts`). Proves two things:
 *  (1) a content-predicate failure carries `contentDerived: true` and a
 *      description that echoes NEITHER the matched substring NOR the raw value;
 *  (2) the sync-path structure ({@link buildBatch} output) has no slot for a
 *      content-derived deviation — no `contentDerived`/`description`/deviation
 *      key exists anywhere in an aggregate batch, and the raw secret never
 *      appears — so such deviations cannot cross the network by construction.
 */

const REPO = 'https://github.com/example-org/sample-repo';
const SECRET = 'AKIAIOSFODNN7EXAMPLE-super-secret-prompt-text';

const detector = new WorkflowDeviationDetector();

function interaction(spanId: string): Interaction {
  return {
    timestampMs: 1_000_000,
    sessionId: 'session',
    traceId: 'trace',
    spanId,
    operation: 'chat',
    agentName: 'copilot',
    agentMode: 'agent',
    model: 'gpt-test',
    durationMs: 100,
    success: true,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    repository: REPO,
  };
}

const config: WorkflowConfig = {
  repository: REPO,
  workflows: [
    {
      name: 'no-secrets-in-prompt',
      expectedSequence: [],
      maxDurationMs: 45 * 60_000,
      sequenceDeviationAlert: true,
      timeoutExceededAlert: false,
      toolUsageAnomalyAlert: false,
      steps: [
        {
          name: 'no-secrets',
          predicate: { operation: 'chat' },
          contentPredicate: { attribute: 'copilot_chat.user_request', contains: 'AKIA', negate: true },
        },
      ],
    },
  ],
};

describe('content-predicate deviation privacy', () => {
  it('flags contentDerived and never echoes the raw attribute value', () => {
    const span = interaction('chat-1');
    // The user_request DOES contain the secret → the "must not contain" fails.
    const lookup: ContentLookup = (attr) =>
      attr === 'copilot_chat.user_request' ? new Map([['chat-1', SECRET]]) : new Map();

    const deviations = detector.detectForTurns([[span]], [config], lookup)[0];
    const missing = deviations.filter((d) => d.type === DeviationType.MissingSteps);
    expect(missing).toHaveLength(1);

    const d = missing[0];
    expect(d.contentDerived).toBe(true);
    expect(d.description).toContain('content condition not met');
    // No part of the raw value or the matched substring leaks into the deviation.
    expect(d.description).not.toContain(SECRET);
    expect(d.description).not.toContain('AKIA');
    // No sequence arrays carry content either.
    expect(JSON.stringify(d)).not.toContain(SECRET);
    expect(JSON.stringify(d)).not.toContain('AKIA');
  });
});

describe('content-derived deviations are structurally absent from the sync path', () => {
  /** Recursively collect every object key reachable in a JSON value. */
  function collectKeys(value: unknown, out: Set<string>): void {
    if (Array.isArray(value)) {
      for (const v of value) {
        collectKeys(v, out);
      }
    } else if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        out.add(k);
        collectKeys(v, out);
      }
    }
  }

  it('an aggregate batch has no deviation/contentDerived/description slot and no raw content', () => {
    // A content-bearing span would only ever feed the LOCAL deviation path; the
    // sync path consumes safe AggregationRows that carry no content at all.
    const rows: AggregationRow[] = [
      {
        startTimeMs: 1_000_000,
        sessionKey: 'session',
        repository: REPO,
        model: 'gpt-test',
        agentMode: 'agent',
        operation: 'chat',
        durationMs: 100,
        statusCode: 1,
        inputTokens: 10,
        outputTokens: 20,
        cachedTokens: 0,
      },
    ];
    const batch = buildBatch({
      rows,
      pseudonymousDeveloperId: 'dev_' + '0'.repeat(32),
      toolVersion: '1.0.0',
      windowStartMs: 1_000_000,
      windowEndMs: 1_000_001,
      generatedAtMs: 1_000_000,
    });

    const keys = new Set<string>();
    collectKeys(batch, keys);
    // The contentDerived flag (and any deviation field) has no slot in the batch.
    expect(keys.has('contentDerived')).toBe(false);
    expect(keys.has('description')).toBe(false);
    expect(keys.has('deviation')).toBe(false);
    expect(keys.has('deviations')).toBe(false);

    // And the raw secret could never appear in a content-free batch.
    expect(JSON.stringify(batch)).not.toContain(SECRET);
    expect(JSON.stringify(batch)).not.toContain('AKIA');
  });
});
