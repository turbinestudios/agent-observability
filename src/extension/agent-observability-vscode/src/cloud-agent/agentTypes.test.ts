import { describe, it, expect } from 'vitest';
import { AGENT_PARSER_VERSION, AGENT_SINK_INDEX_VERSION, agentServiceLabel } from './agentTypes';

describe('agentServiceLabel', () => {
  it('returns the trimmed service name when present', () => {
    expect(agentServiceLabel('error-remediation')).toBe('error-remediation');
    expect(agentServiceLabel('  dependency-updater  ')).toBe('dependency-updater');
  });

  it('falls back to a sentinel for empty / whitespace / undefined', () => {
    expect(agentServiceLabel(undefined)).toBe('unknown-agent');
    expect(agentServiceLabel('')).toBe('unknown-agent');
    expect(agentServiceLabel('   ')).toBe('unknown-agent');
  });
});

describe('version constants', () => {
  it('are positive integers', () => {
    expect(Number.isInteger(AGENT_SINK_INDEX_VERSION)).toBe(true);
    expect(AGENT_SINK_INDEX_VERSION).toBeGreaterThan(0);
    expect(Number.isInteger(AGENT_PARSER_VERSION)).toBe(true);
    expect(AGENT_PARSER_VERSION).toBeGreaterThan(0);
  });
});
