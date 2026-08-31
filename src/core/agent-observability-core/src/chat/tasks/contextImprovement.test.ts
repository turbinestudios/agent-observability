import { describe, it, expect } from 'vitest';
import {
  CONTEXT_PLAN_FENCE,
  IMPROVE_LIMITS,
  buildContextImprovementPrompt,
  parseContextPlan,
} from './contextImprovement';
import type { ProjectContextFile } from './projectContext';

const HOTSPOT = {
  path: 'CLAUDE.md',
  category: 'instruction',
  sessionCount: 12,
  appliedCount: 10,
  skippedCount: 2,
  readCount: 0,
  estTokensMax: 2600,
  errorSessions: 3,
  deviationSessions: 1,
};

const SESSION = {
  title: 'Fix the login bug',
  goal: 'Make the login form validate again',
  verdict: 'struggled',
  outcome: 'partially',
  findings: [{ id: 'correction-reprompt', severity: 'friction', description: 'Three correction re-prompts.' }],
  tips: ['State acceptance criteria up front.'],
};

const GATHERED: ProjectContextFile[] = [
  { path: 'CLAUDE.md', category: 'instruction', content: '# Rules\nOld content.', truncated: false },
  { path: '.github/big.instructions.md', category: 'instruction', content: 'partial…', truncated: true },
];

function plan(edits: unknown[], extra = ''): string {
  return [
    'Here is the plan.',
    extra,
    '```' + CONTEXT_PLAN_FENCE,
    JSON.stringify({ summary: 'Tighten CLAUDE.md', edits }),
    '```',
    'Closing words.',
  ].join('\n');
}

describe('buildContextImprovementPrompt', () => {
  it('carries the evidence, the file digest, and the answer contract', () => {
    const prompt = buildContextImprovementPrompt('github.com/acme/app', [HOTSPOT], [SESSION], GATHERED);
    expect(prompt).toContain('Repository: github.com/acme/app');
    expect(prompt).toContain('| CLAUDE.md | instruction | 12 | 10 | 2 | 0 | 2600 | 3 | 1 |');
    expect(prompt).toContain('Fix the login bug');
    expect(prompt).toContain('correction-reprompt');
    expect(prompt).toContain('----- BEGIN FILE: CLAUDE.md');
    expect(prompt).toContain('```' + CONTEXT_PLAN_FENCE);
    expect(prompt).toContain('"replace" | "create"');
  });

  it('caps hotspots, sessions, findings, and tips at the limits', () => {
    const manyFindings = Array.from({ length: 20 }, (_, n) => ({
      id: `finding-${n}`,
      severity: 'friction',
      description: `d${n}`,
    }));
    const prompt = buildContextImprovementPrompt(
      'r',
      Array.from({ length: 20 }, (_, n) => ({ ...HOTSPOT, path: `f${n}.instructions.md` })),
      [{ ...SESSION, findings: manyFindings, tips: Array.from({ length: 20 }, (_, n) => `tip ${n}`) }],
      [],
    );
    expect(prompt).toContain(`f${IMPROVE_LIMITS.maxHotspots - 1}.instructions.md`);
    expect(prompt).not.toContain(`f${IMPROVE_LIMITS.maxHotspots}.instructions.md |`);
    expect(prompt).toContain(`finding-${IMPROVE_LIMITS.maxFindingsPerSession - 1}`);
    expect(prompt).not.toContain(`finding-${IMPROVE_LIMITS.maxFindingsPerSession} `);
  });
});

describe('parseContextPlan', () => {
  it('keeps a valid replace and create, and strips the fence from the narrative', () => {
    const parsed = parseContextPlan(
      plan([
        { path: 'CLAUDE.md', action: 'replace', content: '# Rules\nNew content.', rationale: 'tighter' },
        { path: 'AGENTS.md', action: 'create', content: '# Agents guide' },
      ]),
      GATHERED,
    );
    expect(parsed.summary).toBe('Tighten CLAUDE.md');
    expect(parsed.edits).toHaveLength(2);
    expect(parsed.invalidEditCount).toBe(0);
    expect(parsed.narrative).toContain('Here is the plan.');
    expect(parsed.narrative).toContain('Closing words.');
    expect(parsed.narrative).not.toContain(CONTEXT_PLAN_FENCE);
    expect(parsed.narrative).not.toContain('New content');
  });

  it('renders the narrative with zero edits when the fence is missing or broken', () => {
    const noFence = parseContextPlan('Just words, no fence.', GATHERED);
    expect(noFence).toEqual({ narrative: 'Just words, no fence.', edits: [], invalidEditCount: 0 });

    const broken = parseContextPlan('```' + CONTEXT_PLAN_FENCE + '\nnot json\n```', GATHERED);
    expect(broken.edits).toEqual([]);
  });

  it('drops unsafe paths — traversal, absolute, and non-allowlisted names', () => {
    const parsed = parseContextPlan(
      plan([
        { path: '../escape/CLAUDE.md', action: 'create', content: 'x' },
        { path: '/etc/CLAUDE.md', action: 'create', content: 'x' },
        { path: 'src/index.ts', action: 'create', content: 'x' },
        { path: '.github/good.instructions.md', action: 'create', content: 'ok' },
      ]),
      GATHERED,
    );
    expect(parsed.edits.map((e) => e.path)).toEqual(['.github/good.instructions.md']);
    expect(parsed.invalidEditCount).toBe(3);
  });

  it('refuses to replace what it never fully saw, or create what already exists', () => {
    const parsed = parseContextPlan(
      plan([
        // Not gathered at all — replacing blind would fabricate the base.
        { path: 'AGENTS.md', action: 'replace', content: 'x' },
        // Gathered truncated — replacing would delete the unseen tail.
        { path: '.github/big.instructions.md', action: 'replace', content: 'x' },
        // Exists — "create" would be a disguised replace.
        { path: 'CLAUDE.md', action: 'create', content: 'x' },
      ]),
      GATHERED,
    );
    expect(parsed.edits).toEqual([]);
    expect(parsed.invalidEditCount).toBe(3);
  });

  it('drops oversized content, duplicate paths, and edits beyond the cap', () => {
    const oversize = 'x'.repeat(IMPROVE_LIMITS.maxEditContentChars + 1);
    const many = Array.from({ length: IMPROVE_LIMITS.maxEdits + 2 }, (_, n) => ({
      path: `${'f'.repeat(n + 1)}.instructions.md`,
      action: 'create',
      content: 'ok',
    }));
    const parsed = parseContextPlan(
      plan([
        { path: 'CLAUDE.md', action: 'replace', content: oversize },
        { path: 'AGENTS.md', action: 'create', content: 'a' },
        { path: 'AGENTS.md', action: 'create', content: 'duplicate' },
        ...many,
      ]),
      GATHERED,
    );
    expect(parsed.edits).toHaveLength(IMPROVE_LIMITS.maxEdits);
    // oversize + duplicate + the three valid candidates beyond the six-edit cap.
    expect(parsed.invalidEditCount).toBe(5);
  });
});
