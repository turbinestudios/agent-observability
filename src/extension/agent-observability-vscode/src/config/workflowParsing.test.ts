import { describe, it, expect } from 'vitest';
import { parseWorkflowConfigs } from './workflowParsing';

/**
 * Headless tests for the pure `agentObservability.workflows` parser. The
 * `Configuration` seam just reads the raw value and forwards it here, so testing
 * this covers both the legacy agent-name shape and the structured predicate DSL,
 * plus the lenient skip-malformed behavior.
 */

const REPO = 'https://github.com/org/repo';
const DEFAULT_MAX_MS = 60 * 60_000;

describe('parseWorkflowConfigs — legacy shape (backward compatible)', () => {
  it('parses expectedSequence and applies alert/duration defaults', () => {
    const configs = parseWorkflowConfigs(
      [{ repository: REPO, workflows: [{ name: 'wf', expectedSequence: ['planner', 'coder'] }] }],
      DEFAULT_MAX_MS,
    );
    expect(configs).toHaveLength(1);
    const w = configs[0].workflows[0];
    expect(w.name).toBe('wf');
    expect(w.expectedSequence).toEqual(['planner', 'coder']);
    expect(w.maxDurationMs).toBe(DEFAULT_MAX_MS);
    expect(w.sequenceDeviationAlert).toBe(true);
    expect(w.timeoutExceededAlert).toBe(true);
    expect(w.toolUsageAnomalyAlert).toBe(true);
    // No new-shape fields when none authored.
    expect(w.triggerPredicate).toBeUndefined();
    expect(w.steps).toBeUndefined();
  });

  it('honors explicit maxDurationMinutes (clamped to >= 1) and alert flags', () => {
    const configs = parseWorkflowConfigs(
      [
        {
          repository: REPO,
          workflows: [
            {
              name: 'wf',
              maxDurationMinutes: 0, // clamped up to 1
              sequenceDeviationAlert: false,
              timeoutExceededAlert: false,
            },
          ],
        },
      ],
      DEFAULT_MAX_MS,
    );
    const w = configs[0].workflows[0];
    expect(w.maxDurationMs).toBe(1 * 60_000);
    expect(w.sequenceDeviationAlert).toBe(false);
    expect(w.timeoutExceededAlert).toBe(false);
    expect(w.toolUsageAnomalyAlert).toBe(true);
  });
});

describe('parseWorkflowConfigs — malformed entries are skipped', () => {
  it('returns [] for a non-array', () => {
    expect(parseWorkflowConfigs(undefined, DEFAULT_MAX_MS)).toEqual([]);
    expect(parseWorkflowConfigs('nope', DEFAULT_MAX_MS)).toEqual([]);
  });

  it('skips entries missing repository, with non-array workflows, or with no valid workflow', () => {
    const configs = parseWorkflowConfigs(
      [
        null,
        'string',
        { workflows: [{ name: 'x' }] }, // missing repository
        { repository: REPO, workflows: 'nope' }, // workflows not an array
        { repository: REPO, workflows: [{}, { name: '   ' }] }, // no valid workflow name
        { repository: REPO, workflows: [{ name: 'good' }] }, // the only valid one
      ],
      DEFAULT_MAX_MS,
    );
    expect(configs).toHaveLength(1);
    expect(configs[0].repository).toBe(REPO);
    expect(configs[0].workflows.map((w) => w.name)).toEqual(['good']);
  });
});

describe('parseWorkflowConfigs — structured predicate DSL', () => {
  it('parses triggerPredicate keeping only known, well-typed fields', () => {
    const configs = parseWorkflowConfigs(
      [
        {
          repository: REPO,
          workflows: [
            {
              name: 'wf',
              triggerPredicate: { agentMode: 'agent', bogus: 'ignored', success: true, model: 7 },
              steps: [{ name: 's', predicate: { agentName: 'coder' } }],
            },
          ],
        },
      ],
      DEFAULT_MAX_MS,
    );
    const w = configs[0].workflows[0];
    expect(w.triggerPredicate).toEqual({ agentMode: 'agent', success: true });
    expect(w.steps).toHaveLength(1);
    expect(w.steps?.[0]).toEqual({ name: 's', predicate: { agentName: 'coder' } });
  });

  it('drops a triggerPredicate with no recognized fields', () => {
    const configs = parseWorkflowConfigs(
      [{ repository: REPO, workflows: [{ name: 'wf', triggerPredicate: { nope: 1 } }] }],
      DEFAULT_MAX_MS,
    );
    expect(configs[0].workflows[0].triggerPredicate).toBeUndefined();
  });

  it('parses a content predicate and keeps the step', () => {
    const configs = parseWorkflowConfigs(
      [
        {
          repository: REPO,
          workflows: [
            {
              name: 'wf',
              steps: [
                {
                  name: 'no-secret',
                  predicate: { operation: 'chat' },
                  contentPredicate: {
                    attribute: 'copilot_chat.user_request',
                    contains: 'AKIA',
                    negate: true,
                  },
                },
              ],
            },
          ],
        },
      ],
      DEFAULT_MAX_MS,
    );
    const step = configs[0].workflows[0].steps?.[0];
    expect(step?.contentPredicate).toEqual({
      attribute: 'copilot_chat.user_request',
      contains: 'AKIA',
      negate: true,
    });
  });

  it('accepts a content-only step (empty/absent metadata predicate)', () => {
    const configs = parseWorkflowConfigs(
      [
        {
          repository: REPO,
          workflows: [
            {
              name: 'wf',
              steps: [
                {
                  name: 'content-only',
                  contentPredicate: { attribute: 'gen_ai.input.messages', contains: 'x' },
                },
              ],
            },
          ],
        },
      ],
      DEFAULT_MAX_MS,
    );
    const step = configs[0].workflows[0].steps?.[0];
    expect(step).toBeDefined();
    expect(step?.predicate).toEqual({});
  });

  it('skips a step whose content predicate names an unsupported attribute, keeping valid siblings', () => {
    const configs = parseWorkflowConfigs(
      [
        {
          repository: REPO,
          workflows: [
            {
              name: 'wf',
              steps: [
                {
                  name: 'bad-attr',
                  predicate: { operation: 'chat' },
                  contentPredicate: { attribute: 'gen_ai.response.id', contains: 'x' },
                },
                { name: 'good', predicate: { agentName: 'coder' } },
              ],
            },
          ],
        },
      ],
      DEFAULT_MAX_MS,
    );
    const steps = configs[0].workflows[0].steps;
    expect(steps?.map((s) => s.name)).toEqual(['good']);
  });

  it('keeps a step with a safe regex but skips one with a ReDoS-unsafe regex', () => {
    const configs = parseWorkflowConfigs(
      [
        {
          repository: REPO,
          workflows: [
            {
              name: 'wf',
              steps: [
                {
                  name: 'safe-regex',
                  predicate: { operation: 'execute_tool' },
                  contentPredicate: { attribute: 'gen_ai.tool.call.arguments', matches: 'src/.*\\.ts$' },
                },
                {
                  name: 'redos-regex',
                  predicate: { operation: 'chat' },
                  contentPredicate: { attribute: 'copilot_chat.user_request', matches: '(a|a)*$' },
                },
              ],
            },
          ],
        },
      ],
      DEFAULT_MAX_MS,
    );
    // The dangerous-regex step is dropped at parse time; the safe one survives.
    expect(configs[0].workflows[0].steps?.map((s) => s.name)).toEqual(['safe-regex']);
  });

  it('skips a content predicate with neither contains nor matches', () => {
    const configs = parseWorkflowConfigs(
      [
        {
          repository: REPO,
          workflows: [
            {
              name: 'wf',
              steps: [
                {
                  name: 'no-condition',
                  predicate: { operation: 'chat' },
                  contentPredicate: { attribute: 'copilot_chat.user_request' },
                },
                { name: 'good', predicate: { agentName: 'coder' } },
              ],
            },
          ],
        },
      ],
      DEFAULT_MAX_MS,
    );
    expect(configs[0].workflows[0].steps?.map((s) => s.name)).toEqual(['good']);
  });

  it('leaves steps undefined when every step is malformed (falls back to expectedSequence path)', () => {
    const configs = parseWorkflowConfigs(
      [
        {
          repository: REPO,
          workflows: [
            {
              name: 'wf',
              expectedSequence: ['planner'],
              steps: [{ predicate: { agentName: 'x' } }, { name: '' }, 'nope'],
            },
          ],
        },
      ],
      DEFAULT_MAX_MS,
    );
    const w = configs[0].workflows[0];
    expect(w.steps).toBeUndefined();
    expect(w.expectedSequence).toEqual(['planner']);
  });
});
