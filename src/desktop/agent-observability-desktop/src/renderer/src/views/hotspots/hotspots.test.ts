import { describe, it, expect } from 'vitest';
import type { AnalysisStatus, HotspotRow } from '../../../../shared/rpc';
import {
  OVERSIZED_THRESHOLD_TOKENS,
  categoryLabel,
  describeCoverage,
  describeProgress,
  isOversized,
  shortPath,
} from './hotspots';

function status(over: Partial<AnalysisStatus> = {}): AnalysisStatus {
  return { analyzed: 10, total: 10, running: false, ...over };
}

function hotspot(file: string): HotspotRow {
  return {
    file,
    name: 'CLAUDE.md',
    category: 'instruction',
    sessionCount: 1,
    appliedCount: 1,
    skippedCount: 0,
    readCount: 0,
    estTokensMax: 100,
    errorSessions: 0,
    deviationSessions: 0,
    lastSeenMs: 1_000,
  };
}

describe('categoryLabel', () => {
  it('names the categories a context file can have', () => {
    expect(categoryLabel('instruction')).toBe('Instruction');
    expect(categoryLabel('skill')).toBe('Skill');
  });

  it('falls back for a category it does not recognize, rather than showing a raw key', () => {
    expect(categoryLabel('unknown')).toBe('Other');
    expect(categoryLabel('something-new')).toBe('Other');
  });
});

describe('isOversized', () => {
  it('flags a file above the guideline and not one exactly on it', () => {
    expect(isOversized(OVERSIZED_THRESHOLD_TOKENS + 1)).toBe(true);
    expect(isOversized(OVERSIZED_THRESHOLD_TOKENS)).toBe(false);
    expect(isOversized(0)).toBe(false);
  });
});

describe('shortPath', () => {
  it('keeps the tail, which is the part that says what a file is', () => {
    expect(shortPath('/home/me/work/repo/.claude/skills/deploy.md')).toBe(
      '…/.claude/skills/deploy.md',
    );
  });

  it('leaves a short path whole', () => {
    expect(shortPath('repo/CLAUDE.md')).toBe('repo/CLAUDE.md');
  });

  it('reads Windows paths the same way', () => {
    expect(shortPath(String.raw`C:\work\repo\.claude\agents\explore.md`)).toBe(
      '…/.claude/agents/explore.md',
    );
  });

  it('handles a bare name, which is what a file with no resolved path leaves', () => {
    expect(shortPath('deploy')).toBe('deploy');
  });
});

describe('describeProgress', () => {
  it('says nothing once the analysis has caught up', () => {
    expect(describeProgress(status())).toBeUndefined();
  });

  it('says how much is left while sessions are still being read', () => {
    expect(describeProgress(status({ analyzed: 40, total: 300, running: true }))).toContain('260');
  });

  it('still speaks up when a pass is running with nothing left to read', () => {
    expect(describeProgress(status({ analyzed: 10, total: 10, running: true }))).toBe('Finishing up…');
  });

  it('speaks up for a backlog even when no pass is in flight', () => {
    // Sessions went stale while the app was closed: the ranking is out of date
    // and must not present itself as complete.
    expect(describeProgress(status({ analyzed: 5, total: 10, running: false }))).toContain('5');
  });
});

describe('describeCoverage', () => {
  it('says what the ranking is built from', () => {
    expect(describeCoverage([hotspot('/a'), hotspot('/b')], status({ analyzed: 12 }))).toBe(
      '2 files across the 12 sessions analyzed so far.',
    );
  });

  it('uses the singular for one of each', () => {
    expect(describeCoverage([hotspot('/a')], status({ analyzed: 1 }))).toBe(
      '1 file across the 1 session analyzed so far.',
    );
  });

  it('does not claim coverage it has none of', () => {
    expect(describeCoverage([], status({ analyzed: 0, total: 3 }))).toBe(
      'No context files found yet.',
    );
  });
});
