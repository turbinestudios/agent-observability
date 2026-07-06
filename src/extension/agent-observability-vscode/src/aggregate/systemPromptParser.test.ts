import { describe, it, expect } from 'vitest';
import { parseSystemPromptContextFiles } from './systemPromptParser';

describe('parseSystemPromptContextFiles', () => {
  it('extracts customization files from <file> elements with absolute paths', () => {
    const text = [
      '<instructions>',
      '<instruction>',
      '<file>c:\\repo\\.github\\instructions\\security.instructions.md</file>',
      '<description>Security rules</description>',
      '<applyTo>src/**</applyTo>',
      '</instruction>',
      '</instructions>',
      '<skills>',
      '<skill><name>tour</name><file>c:\\repo\\.github\\skills\\tour\\SKILL.md</file></skill>',
      '</skills>',
    ].join('\n');

    const files = parseSystemPromptContextFiles(text);
    expect(files).toEqual([
      { name: 'security.instructions.md', filePath: 'c:\\repo\\.github\\instructions\\security.instructions.md' },
      { name: 'SKILL.md', filePath: 'c:\\repo\\.github\\skills\\tour\\SKILL.md' },
    ]);
  });

  it('drops non-customization <file> entries (arbitrary source/doc files)', () => {
    const text = [
      '<file>c:/repo/src/index.ts</file>',
      '<file>c:/repo/README.md</file>',
      '<file>c:/repo/AGENTS.md</file>',
      '<file>c:/repo/.github/prompts/refactor.prompt.md</file>',
    ].join('\n');

    const files = parseSystemPromptContextFiles(text);
    expect(files.map((f) => f.name)).toEqual(['AGENTS.md', 'refactor.prompt.md']);
  });

  it('dedupes a file listed multiple times (case/slash-insensitive) to one entry', () => {
    const text = [
      '<file>c:\\repo\\.github\\copilot-instructions.md</file>',
      '<file>c:/repo/.github/copilot-instructions.md</file>',
      '<file>C:\\REPO\\.github\\copilot-instructions.md</file>',
    ].join('\n');

    const files = parseSystemPromptContextFiles(text);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('copilot-instructions.md');
  });

  it('handles whitespace/newlines inside the <file> element', () => {
    const text = '<file>\n   c:/repo/.agents/reviewer.agent.md   \n</file>';
    const files = parseSystemPromptContextFiles(text);
    expect(files).toEqual([{ name: 'reviewer.agent.md', filePath: 'c:/repo/.agents/reviewer.agent.md' }]);
  });

  it('returns [] for empty, undefined, or marker-free text', () => {
    expect(parseSystemPromptContextFiles(undefined)).toEqual([]);
    expect(parseSystemPromptContextFiles('')).toEqual([]);
    expect(parseSystemPromptContextFiles('no file markers here')).toEqual([]);
  });
});
