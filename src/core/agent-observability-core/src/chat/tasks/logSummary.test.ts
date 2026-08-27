import { describe, it, expect } from 'vitest';
import { buildSummaryDigest, toSafeSessionRow, type SummaryInput } from './logSummary';
import type { OverviewMetrics, SessionSummary } from '../../telemetry/models';

const overview: OverviewMetrics = {
  totalInteractions: 120,
  totalSessions: 8,
  totalRepositories: 2,
  totalModels: 1,
  avgDurationMs: 4200,
  inputTokens: 50_000,
  outputTokens: 12_000,
  cachedTokens: 8_000,
  errorCount: 3,
};

const SECRET_TITLE = 'SECRET_FIX_THE_LOGIN_BUG_PLEASE';

const session: SessionSummary = {
  sessionId: 'sess-1',
  repository: 'https://github.com/org/repo',
  startedAtMs: 1_000,
  endedAtMs: 5_000,
  durationMs: 4_000,
  interactionCount: 10,
  llmCalls: 6,
  toolCalls: 4,
  inputTokens: 5_000,
  outputTokens: 1_200,
  cachedTokens: 800,
  model: 'gpt-4o',
  agentModes: ['agent'],
  title: SECRET_TITLE,
  titleDerived: true,
};

describe('toSafeSessionRow', () => {
  it('omits the title (and titleDerived) from the projection', () => {
    const row = toSafeSessionRow(session) as unknown as Record<string, unknown>;
    expect('title' in row).toBe(false);
    expect('titleDerived' in row).toBe(false);
    expect(row.repository).toBe('https://github.com/org/repo');
  });
});

describe('buildSummaryDigest — privacy regression', () => {
  const input: SummaryInput = {
    overview,
    sessions: [toSafeSessionRow(session)],
    repositories: [
      {
        repository: 'https://github.com/org/repo',
        sessionCount: 8,
        interactionCount: 120,
        models: ['gpt-4o'],
        lastActivityMs: 5_000,
      },
    ],
  };

  it('never includes the session title (raw, user-derived content)', () => {
    const digest = buildSummaryDigest(input);
    expect(digest).not.toContain(SECRET_TITLE);
    expect(digest).not.toContain('SECRET');
  });

  it('includes safe overview, repository and per-model token figures', () => {
    const digest = buildSummaryDigest(input);
    expect(digest).toContain('Sessions: 8');
    expect(digest).toContain('https://github.com/org/repo');
    expect(digest).toContain('gpt-4o');
  });
});
