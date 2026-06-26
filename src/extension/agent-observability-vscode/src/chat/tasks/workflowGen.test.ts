import { describe, it, expect } from 'vitest';
import {
  buildWorkflowGenPreamble,
  mergeWorkflowsByRepository,
  validateWorkflowResponse,
} from './workflowGen';

const DEFAULT_MAX_MS = 60 * 60_000;

function workflowsBlock(json: string): string {
  return 'Here you go:\n\n```ao-workflows\n' + json + '\n```\n';
}

describe('buildWorkflowGenPreamble', () => {
  it('grounds the task on the project context files and the ao-workflows fence', () => {
    const preamble = buildWorkflowGenPreamble('CONTEXT', 'DIGEST');
    expect(preamble).toContain('CONTEXT');
    expect(preamble).toContain('DIGEST');
    expect(preamble).toContain('ao-workflows');
    expect(preamble).toMatch(/project context files/i);
    // It must instruct the model NOT to invent things absent context files.
    expect(preamble).toMatch(/do not (fabricate|invent)/i);
  });
});

describe('validateWorkflowResponse', () => {
  it('accepts a valid ao-workflows block and returns the raw array', () => {
    const json = JSON.stringify([
      { repository: 'https://github.com/org/repo', workflows: [{ name: 'feature' }] },
    ]);
    const result = validateWorkflowResponse(workflowsBlock(json), DEFAULT_MAX_MS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Array.isArray(result.value)).toBe(true);
      expect(result.value).toHaveLength(1);
    }
  });

  it('falls back to a plain json block', () => {
    const json = JSON.stringify([
      { repository: 'https://github.com/org/repo', workflows: [{ name: 'feature' }] },
    ]);
    const response = '```json\n' + json + '\n```';
    expect(validateWorkflowResponse(response, DEFAULT_MAX_MS).ok).toBe(true);
  });

  it('rejects a response with no code block', () => {
    const r = validateWorkflowResponse('no block here', DEFAULT_MAX_MS);
    expect(r.ok).toBe(false);
  });

  it('rejects invalid JSON', () => {
    const r = validateWorkflowResponse(workflowsBlock('{not json'), DEFAULT_MAX_MS);
    expect(r.ok).toBe(false);
  });

  it('rejects a non-array', () => {
    const r = validateWorkflowResponse(workflowsBlock('{"repository":"x"}'), DEFAULT_MAX_MS);
    expect(r.ok).toBe(false);
  });

  it('rejects an array the production parser drops entirely', () => {
    // Missing required `name` on the workflow → parser skips it → zero configs.
    const json = JSON.stringify([{ repository: 'https://github.com/org/repo', workflows: [{}] }]);
    const r = validateWorkflowResponse(workflowsBlock(json), DEFAULT_MAX_MS);
    expect(r.ok).toBe(false);
  });
});

describe('mergeWorkflowsByRepository', () => {
  const repoA = { repository: 'https://github.com/org/a', workflows: [{ name: 'old' }] };
  const repoAnew = { repository: 'https://github.com/org/a', workflows: [{ name: 'new' }] };
  const repoB = { repository: 'https://github.com/org/b', workflows: [{ name: 'b' }] };

  it('replaces an existing repository entry in place', () => {
    const merged = mergeWorkflowsByRepository([repoA], [repoAnew]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual(repoAnew);
  });

  it('appends entries for new repositories and keeps the others', () => {
    const merged = mergeWorkflowsByRepository([repoA], [repoB]);
    expect(merged).toHaveLength(2);
    expect(merged).toContainEqual(repoA);
    expect(merged).toContainEqual(repoB);
  });

  it('treats a non-array existing value as empty', () => {
    expect(mergeWorkflowsByRepository(undefined, [repoB])).toEqual([repoB]);
  });
});
