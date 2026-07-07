import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isHousekeepingUserPrompt, parseCloudSessionLog } from './sseParser';
import { CloudToolInvocation, ParsedCloudLog } from './cloudTypes';

/** Load the shape-faithful CAPI SSE fixture and parse it once for the suite. */
function parseFixture(): ParsedCloudLog {
  const raw = readFileSync(resolve(__dirname, './fixtures/session-log.sse'), 'utf8');
  return parseCloudSessionLog(raw);
}

/** Index the tool invocations by their tool_calls[].id for keyed assertions. */
function byId(invocations: CloudToolInvocation[]): Map<string, CloudToolInvocation> {
  return new Map(invocations.map((inv) => [inv.id, inv]));
}

describe('parseCloudSessionLog (fixtures/session-log.sse)', () => {
  it('surfaces the real user prompt and excludes the PR housekeeping prompt', () => {
    const parsed = parseFixture();
    expect(parsed.userRequests).toHaveLength(1);
    expect(parsed.userRequests[0]).toBe(
      'You have been given comments on the previous commits. Implement the requested feature: add a retry with backoff to the API client.',
    );
    // The "generate a concise pull request title and description" prompt is dropped.
    expect(parsed.userRequests.some((r) => r.toLowerCase().includes('pull request title'))).toBe(false);
  });

  it('keys 4 invocations by tool_calls[].id', () => {
    const parsed = parseFixture();
    expect(parsed.toolInvocations).toHaveLength(4);
    const ids = parsed.toolInvocations.map((inv) => inv.id);
    expect(new Set(ids)).toEqual(new Set(['toolu_setup1', 'toolu_view1', 'toolu_edit1', 'toolu_mcp1']));
  });

  it('flags the two run_setup ops as setup and the view/edit ops as not', () => {
    const map = byId(parseFixture().toolInvocations);
    expect(map.get('toolu_setup1')?.isSetup).toBe(true);
    expect(map.get('toolu_mcp1')?.isSetup).toBe(true);
    expect(map.get('toolu_view1')?.isSetup).toBe(false);
    expect(map.get('toolu_edit1')?.isSetup).toBe(false);
  });

  it('counts exactly 2 non-setup tool invocations', () => {
    const invocations = parseFixture().toolInvocations;
    expect(invocations.filter((inv) => !inv.isSetup)).toHaveLength(2);
    expect(invocations.filter((inv) => inv.isSetup)).toHaveLength(2);
  });

  it('marks toolu_edit1 unsuccessful because its role:tool result was is_error:true', () => {
    const map = byId(parseFixture().toolInvocations);
    expect(map.get('toolu_edit1')?.success).toBe(false);
    // Every other invocation had no error result and stays successful.
    expect(map.get('toolu_setup1')?.success).toBe(true);
    expect(map.get('toolu_view1')?.success).toBe(true);
    expect(map.get('toolu_mcp1')?.success).toBe(true);
  });

  it('computes durations across mixed second/millisecond created magnitudes', () => {
    const map = byId(parseFixture().toolInvocations);
    // seconds → ms: 1720000000s..1720000002s
    expect(map.get('toolu_setup1')?.durationMs).toBe(2000);
    // seconds → ms: 1720000003s..1720000005s
    expect(map.get('toolu_view1')?.durationMs).toBe(2000);
    // seconds → ms: 1720000006s..1720000010s
    expect(map.get('toolu_edit1')?.durationMs).toBe(4000);
    // already-ms: 1720000012000ms..1720000014000ms
    expect(map.get('toolu_mcp1')?.durationMs).toBe(2000);

    // Concrete normalized start/end for the ms-magnitude invocation.
    const mcp = map.get('toolu_mcp1');
    expect(mcp?.startedAtMs).toBe(1720000012000);
    expect(mcp?.endedAtMs).toBe(1720000014000);
    // And for a second-magnitude one, seconds are multiplied to ms.
    expect(map.get('toolu_view1')?.startedAtMs).toBe(1720000003000);
    expect(map.get('toolu_view1')?.endedAtMs).toBe(1720000005000);
  });

  it('returns invocations sorted by start time', () => {
    const invocations = parseFixture().toolInvocations;
    expect(invocations.map((inv) => inv.id)).toEqual([
      'toolu_setup1',
      'toolu_view1',
      'toolu_edit1',
      'toolu_mcp1',
    ]);
  });

  it('captures the stop-chunk content as the final response', () => {
    const parsed = parseFixture();
    expect(parsed.finalResponse).toBe(
      'Implemented retry with exponential backoff in the API client and added a unit test.',
    );
  });

  it('summs disjoint token usage (prompt minus cached)', () => {
    const parsed = parseFixture();
    expect(parsed.tokenUsage).toEqual({
      inputTokens: 700,
      cachedTokens: 300,
      outputTokens: 200,
    });
  });

  it('counts distinct chunk ids as llm turns and skips nothing in the clean fixture', () => {
    const parsed = parseFixture();
    expect(parsed.llmTurns).toBe(5); // turn-0..turn-4
    expect(parsed.skipped).toBe(0);
  });
});

describe('parseCloudSessionLog (inline edge cases)', () => {
  it('increments skipped for an unknown/garbage data line without throwing', () => {
    const raw = [
      'data: {"role":"user","content":"real prompt"}',
      'data: @@@ not valid json @@@',
    ].join('\n');
    let parsed: ParsedCloudLog | undefined;
    expect(() => {
      parsed = parseCloudSessionLog(raw);
    }).not.toThrow();
    expect(parsed?.skipped).toBe(1);
    // The valid line before it was still parsed.
    expect(parsed?.userRequests).toEqual(['real prompt']);
  });

  it('also skips a JSON primitive that is not an object', () => {
    const parsed = parseCloudSessionLog('data: 12345');
    expect(parsed.skipped).toBe(1);
    expect(parsed.toolInvocations).toEqual([]);
  });

  it('yields tokenUsage undefined when no usage chunks are present', () => {
    const raw = [
      'data: {"role":"user","content":"hi"}',
      'data: {"id":"t0","object":"chat.completion.chunk","created":1720000000,"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}',
    ].join('\n');
    const parsed = parseCloudSessionLog(raw);
    expect(parsed.tokenUsage).toBeUndefined();
    expect(parsed.finalResponse).toBe('answer');
    expect(parsed.skipped).toBe(0);
  });

  it('ignores blank lines, non-data lines, and a [DONE] sentinel without skipping', () => {
    const raw = [
      '',
      ': this is an SSE comment',
      'event: message',
      'data: {"role":"user","content":"hello"}',
      'data: [DONE]',
    ].join('\n');
    const parsed = parseCloudSessionLog(raw);
    expect(parsed.userRequests).toEqual(['hello']);
    expect(parsed.skipped).toBe(0);
  });
});

describe('isHousekeepingUserPrompt', () => {
  it('matches the PR title/description housekeeping templates (PR-gated)', () => {
    expect(
      isHousekeepingUserPrompt('Now generate a concise pull request title and description summarizing the changes.'),
    ).toBe(true);
    expect(isHousekeepingUserPrompt('Write the PR title and description.')).toBe(true);
    expect(isHousekeepingUserPrompt('Suggest a concise title for the pull request.')).toBe(true);
    // Title + description + pull request in any order.
    expect(
      isHousekeepingUserPrompt('For this pull request, provide a description and a fitting title.'),
    ).toBe(true);
  });

  it('does not match a genuine feature request (no false positives)', () => {
    expect(
      isHousekeepingUserPrompt(
        'You have been given comments on the previous commits. Implement the requested feature: add a retry with backoff to the API client.',
      ),
    ).toBe(false);
    expect(isHousekeepingUserPrompt('Fix the flaky test in the client module.')).toBe(false);
    // Mentions a title but nothing PR-related → NOT housekeeping (the fixed false positives).
    expect(isHousekeepingUserPrompt('Add a title bar to the settings screen.')).toBe(false);
    expect(isHousekeepingUserPrompt('Add a title and a description field to the signup form.')).toBe(false);
    expect(isHousekeepingUserPrompt('Please come up with a title for this change.')).toBe(false);
  });
});
