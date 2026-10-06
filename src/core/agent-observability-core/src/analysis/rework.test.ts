import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ActivityFileEdit } from './sessionActivity';
import type { SessionDetail } from '../telemetry/models';
import { buildSessionRetrospective } from './retrospective';
import { renderFileRework } from '../views/sessionDetailHtml';
import {
  REEDIT_MIN_TURNS,
  REWORKED_LINES_MIN,
  displayReworkPath,
  fileEditStats,
  isReedited,
  summarizeRework,
  type FileEditStat,
} from './rework';

function edit(over: Partial<ActivityFileEdit> & Pick<ActivityFileEdit, 'path' | 'turnIndex'>): ActivityFileEdit {
  return { order: over.turnIndex, linesAdded: 2, linesRemoved: 1, created: false, tool: 'Edit', ...over };
}

function stat(over: Partial<FileEditStat> = {}): FileEditStat {
  return { file: '/r/a.ts', editCalls: 1, editTurns: 1, linesAdded: 1, linesRemoved: 0, reworkedLines: 0, outsideRepo: false, ...over };
}

/** The smallest detail the retrospective accepts: no turns, so no other signal fires. */
function emptyDetail(): SessionDetail {
  return {
    summary: {
      sessionId: 's',
      repository: 'unknown',
      startedAtMs: 0,
      endedAtMs: 0,
      durationMs: 0,
      interactionCount: 0,
      llmCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      model: 'unknown',
      agentModes: [],
    },
    treeStats: { modelTurns: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, errorCount: 0, aiuNano: 0 },
    turns: [],
    modelUsage: [],
    agentUsage: [],
    treeModelTurns: [],
  } as unknown as SessionDetail;
}

describe('fileEditStats', () => {
  it('folds calls per file, counting distinct turns, and ranks the most re-edited first', () => {
    const stats = fileEditStats(
      [
        edit({ path: '/r/a.ts', turnIndex: 0 }),
        edit({ path: '/r/a.ts', turnIndex: 0 }),
        edit({ path: '/r/a.ts', turnIndex: 2 }),
        edit({ path: '/r/a.ts', turnIndex: 5 }),
        edit({ path: '/r/b.ts', turnIndex: 1 }),
        edit({ path: '/elsewhere/c.ts', turnIndex: 1 }),
      ],
      {
        isInsideRepo: (p) => p.startsWith('/r/'),
        repoRoot: '/r',
        reworkedLinesByFile: { '/r/b.ts': 4 },
      },
    );
    expect(stats.map((s) => s.file)).toEqual(['/r/a.ts', '/r/b.ts', '/elsewhere/c.ts']);
    expect(stats[0]).toMatchObject({ editCalls: 4, editTurns: 3, linesAdded: 8, linesRemoved: 4, displayPath: 'a.ts' });
    expect(stats[1].reworkedLines).toBe(4);
    expect(stats[2]).toMatchObject({ outsideRepo: true, displayPath: 'c.ts' });
    expect(isReedited(stats[0])).toBe(true);
    expect(isReedited(stats[1])).toBe(false);
  });

  it('accepts a Map of reworked lines and treats every file as inside without a test', () => {
    const stats = fileEditStats([edit({ path: 'x', turnIndex: 0 })], { reworkedLinesByFile: new Map([['x', 7]]) });
    expect(stats[0]).toMatchObject({ reworkedLines: 7, outsideRepo: false });
  });
});

describe('summarizeRework', () => {
  it('fires on a re-edited file or on enough reworked lines, and on neither otherwise', () => {
    expect(summarizeRework([stat()])).toMatchObject({ filesEdited: 1, filesReedited: 0, fired: false });
    expect(summarizeRework([stat({ editTurns: REEDIT_MIN_TURNS })])).toMatchObject({ filesReedited: 1, fired: true });
    expect(summarizeRework([stat({ reworkedLines: REWORKED_LINES_MIN - 1 })]).fired).toBe(false);
    expect(
      summarizeRework([stat({ reworkedLines: REWORKED_LINES_MIN - 1 }), stat({ file: '/r/b.ts', reworkedLines: 1, outsideRepo: true })]),
    ).toMatchObject({ reworkedLines: REWORKED_LINES_MIN, filesOutsideRepo: 1, fired: true });
  });
});

describe('displayReworkPath', () => {
  it('is repository-relative inside the root, a bare name outside it or without one, never absolute', () => {
    expect(displayReworkPath('/home/u/repo/src/a.ts', '/home/u/repo', false)).toBe('src/a.ts');
    expect(displayReworkPath('C:\\Users\\u\\Repo\\src\\a.ts', 'c:\\users\\u\\repo', false)).toBe('src/a.ts');
    expect(displayReworkPath('/home/u/other/a.ts', '/home/u/repo', false)).toBe('a.ts');
    expect(displayReworkPath('/home/u/repo/src/a.ts', '/home/u/repo', true)).toBe('a.ts');
    expect(displayReworkPath('/home/u/repo/src/a.ts', undefined, false)).toBe('a.ts');
  });
});

describe('retrospective integration', () => {
  it('raises file-rework as friction, lifts a smooth session to bumpy and no further, and advises narrowing', () => {
    const fileEdits = [stat({ editTurns: 4, reworkedLines: 12, displayPath: 'a.ts' })];
    const retro = buildSessionRetrospective(emptyDetail(), {
      interruptionCount: 0,
      endedWithInterruption: false,
      compactionCount: 0,
      planModeUsed: false,
      apiErrorCount: 0,
      lastEvent: 'assistant-response',
      fileEdits,
    });
    const finding = retro.findings.find((f) => f.id === 'file-rework');
    expect(finding).toMatchObject({ severity: 'friction', contentDerived: false });
    expect(finding?.description).not.toContain('a.ts');
    expect(retro.verdict).toBe('bumpy');
    expect(retro.verdictReasons).toContain('file-rework');
    expect(retro.counts.rework).toEqual({ filesEdited: 1, filesReedited: 1, reworkedLines: 12, filesOutsideRepo: 0 });
    expect(retro.tips.map((t) => t.id)).toContain('narrow-the-change');
    expect(retro.fileEdits).toEqual(fileEdits);
  });

  it('stays silent, and smooth, when nothing was reworked or the source cannot see edits', () => {
    const signals = {
      interruptionCount: 0,
      endedWithInterruption: false,
      compactionCount: 0,
      planModeUsed: false,
      apiErrorCount: 0,
      lastEvent: 'assistant-response' as const,
    };
    const quiet = buildSessionRetrospective(emptyDetail(), { ...signals, fileEdits: [stat()] });
    expect(quiet.findings.some((f) => f.id === 'file-rework')).toBe(false);
    expect(quiet.verdict).toBe('smooth');
    const blind = buildSessionRetrospective(emptyDetail(), signals);
    expect(blind.counts.rework).toBeUndefined();
    expect(blind.fileEdits).toBeUndefined();
  });
});

describe('renderFileRework', () => {
  it('lists re-edited files by display path, labelled as a proxy, and never prints the absolute path', () => {
    const retro = buildSessionRetrospective(emptyDetail(), {
      interruptionCount: 0,
      endedWithInterruption: false,
      compactionCount: 0,
      planModeUsed: false,
      apiErrorCount: 0,
      lastEvent: 'assistant-response',
      fileEdits: [
        stat({ file: '/home/u/repo/src/a.ts', displayPath: 'src/a.ts', editTurns: 3 }),
        stat({ file: '/tmp/scratch/<b>.ts', displayPath: '<b>.ts', editTurns: 3, outsideRepo: true }),
        stat({ file: '/home/u/repo/src/once.ts', displayPath: 'src/once.ts' }),
      ],
    });
    const html = renderFileRework(retro);
    expect(html).toContain('Files edited repeatedly (2)');
    expect(html).toContain('src/a.ts');
    expect(html).toContain('&lt;b&gt;.ts');
    expect(html).toContain('(outside the repository)');
    expect(html).toContain('Signals of rework, not a quality score.');
    expect(html).not.toContain('/home/u/repo');
    expect(html).not.toContain('once.ts');
    expect(renderFileRework(buildSessionRetrospective(emptyDetail()))).toBe('');
  });
});

describe('vendor payloads never carry file-edit paths', () => {
  it('no AI payload builder reads fileEdits or serialises a whole retrospective', () => {
    const core = path.join(__dirname, '..');
    const desk = path.join(__dirname, '..', '..', '..', '..', 'desktop', 'agent-observability-desktop', 'src', 'datahost');
    const files = [
      path.join(core, 'chat', 'tasks', 'deepRetrospective.ts'),
      path.join(core, 'chat', 'tasks', 'assistantGrounding.ts'),
      path.join(core, 'chat', 'tasks', 'contextImprovement.ts'),
      path.join(desk, 'aiHelper.ts'),
      path.join(desk, 'deepRetro.ts'),
      path.join(desk, 'improve', 'contextPlan.ts'),
    ];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/fileEdits/);
      expect(text, file).not.toMatch(/JSON\.stringify\(\s*(retro|retrospective|heuristic)\b/);
      expect(text, file).not.toMatch(/\.\.\.(retro|retrospective|heuristic)\b/);
    }
  });
});
