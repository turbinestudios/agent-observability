import { describe, it, expect } from 'vitest';
import { filterAcceptedMissing, AcceptedMissingConfig } from './contextAnalyzer';
import type { ExpectedMissingFile } from './models';

describe('filterAcceptedMissing', () => {
  const entries: ExpectedMissingFile[] = [
    {
      name: 'missing-skill.md',
      referencedBy: [
        { sourceFile: 'copilot-instructions.md', referencedFile: 'missing-skill.md', referenceType: 'name-ref' },
      ],
    },
    {
      name: 'helper-utils.md',
      referencedBy: [
        { sourceFile: 'copilot-instructions.md', referencedFile: 'helper-utils.md', referenceType: 'file-path' },
        { sourceFile: 'monorepo.md', referencedFile: 'helper-utils.md', referenceType: 'name-ref' },
      ],
    },
    {
      name: 'only-from-mono.md',
      referencedBy: [
        { sourceFile: 'monorepo.md', referencedFile: 'only-from-mono.md', referenceType: 'yaml-ref' },
      ],
    },
  ];

  it('returns entries unchanged when config is empty', () => {
    const config: AcceptedMissingConfig = { files: [], sources: [] };
    const result = filterAcceptedMissing(entries, config);
    expect(result).toEqual(entries);
  });

  it('removes entries by accepted file name', () => {
    const config: AcceptedMissingConfig = { files: ['missing-skill.md'], sources: [] };
    const result = filterAcceptedMissing(entries, config);
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.name)).toEqual(['helper-utils.md', 'only-from-mono.md']);
  });

  it('removes entries when all references come from an accepted source', () => {
    const config: AcceptedMissingConfig = { files: [], sources: ['monorepo.md'] };
    const result = filterAcceptedMissing(entries, config);
    // 'only-from-mono.md' is fully suppressed (only referenced by monorepo.md)
    // 'helper-utils.md' retains its reference from copilot-instructions.md
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.name)).toEqual(['missing-skill.md', 'helper-utils.md']);
    // Verify partial reference removal
    const helper = result.find((e) => e.name === 'helper-utils.md')!;
    expect(helper.referencedBy).toHaveLength(1);
    expect(helper.referencedBy[0].sourceFile).toBe('copilot-instructions.md');
  });

  it('combines file and source exclusions', () => {
    const config: AcceptedMissingConfig = {
      files: ['missing-skill.md'],
      sources: ['monorepo.md'],
    };
    const result = filterAcceptedMissing(entries, config);
    // missing-skill.md → removed by file exclusion
    // helper-utils.md → partial (monorepo ref removed, copilot ref remains)
    // only-from-mono.md → removed by source exclusion
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('helper-utils.md');
    expect(result[0].referencedBy).toHaveLength(1);
  });

  it('removes entry entirely when source exclusion removes all its references', () => {
    const config: AcceptedMissingConfig = { files: [], sources: ['copilot-instructions.md', 'monorepo.md'] };
    const result = filterAcceptedMissing(entries, config);
    // All entries have all their references suppressed
    expect(result).toHaveLength(0);
  });
});
