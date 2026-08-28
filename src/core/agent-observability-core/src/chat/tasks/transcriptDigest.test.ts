import { describe, expect, it } from 'vitest';
import type { SessionTurn } from '../../telemetry/models';
import { DEEP_RETRO_CAPS, buildTranscriptDigest } from './transcriptDigest';

function turn(overrides: Partial<SessionTurn> = {}): SessionTurn {
  return {
    timestampMs: 0,
    agentMode: 'agent',
    model: 'model-a',
    durationMs: 0,
    success: true,
    llmCalls: 1,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    linesOfCode: 0,
    linesOfDoc: 0,
    linesOfCodeRemoved: 0,
    linesOfDocRemoved: 0,
    events: [],
    ...overrides,
  };
}

describe('buildTranscriptDigest', () => {
  it('renders prompt, response, and code lines per turn', () => {
    const lines = buildTranscriptDigest(
      [turn({ userRequest: 'Fix the bug', finalResponse: 'Done.', linesOfCode: 3 })],
      DEEP_RETRO_CAPS,
    ).join('\n');
    expect(lines).toContain('## Turn 1');
    expect(lines).toContain('Developer asked: Fix the bug');
    expect(lines).toContain('Assistant finished: Done.');
    expect(lines).toContain('Code lines: +3 / -0');
  });

  it('caps prompts and responses at the configured budget', () => {
    const caps = { promptChars: 20, responseChars: 10, maxTurns: 30, headTurns: 10 };
    const lines = buildTranscriptDigest(
      [turn({ userRequest: 'x'.repeat(100), finalResponse: 'y'.repeat(100) })],
      caps,
    ).join('\n');
    const asked = lines.split('Developer asked: ')[1].split('\n')[0];
    const finished = lines.split('Assistant finished: ')[1].split('\n')[0];
    expect(asked.length).toBeLessThanOrEqual(20);
    expect(finished.length).toBeLessThanOrEqual(10);
    expect(asked.endsWith('…')).toBe(true);
  });

  it('samples head and tail of a long session and says what was omitted', () => {
    const caps = { promptChars: 100, responseChars: 100, maxTurns: 6, headTurns: 2 };
    const turns = Array.from({ length: 10 }, (_, i) => turn({ userRequest: `prompt ${i + 1}` }));
    const lines = buildTranscriptDigest(turns, caps).join('\n');
    expect(lines).toContain('prompt 1');
    expect(lines).toContain('prompt 2');
    expect(lines).not.toContain('prompt 3');
    expect(lines).toContain('prompt 10');
    expect(lines).toContain('(… 4 middle turns omitted …)');
  });

  it('describes an interruption instead of quoting its marker text', () => {
    const lines = buildTranscriptDigest(
      [turn({ userRequest: '[Request interrupted by user for tool use]' })],
      DEEP_RETRO_CAPS,
    ).join('\n');
    expect(lines).toContain('The developer interrupted the agent here.');
    expect(lines).not.toContain('[Request interrupted');
  });

  it('summarizes tools by name and failure count, never their output', () => {
    const lines = buildTranscriptDigest(
      [
        turn({
          events: [
            { operation: 'execute_tool', toolName: 'Bash', success: true, timestampMs: 0, durationMs: 0 },
            { operation: 'execute_tool', toolName: 'Bash', success: false, timestampMs: 0, durationMs: 0 },
          ] as SessionTurn['events'],
        }),
      ],
      DEEP_RETRO_CAPS,
    ).join('\n');
    expect(lines).toContain('Tools: Bash ×1, failed ×1');
  });
});
