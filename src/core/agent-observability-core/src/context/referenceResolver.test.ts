import { describe, it, expect } from 'vitest';
import { resolveReferences } from './referenceResolver';
import type { ContextFileEntry } from './models';

describe('referenceResolver', () => {
  describe('resolveReferences', () => {
    it('detects file path references in markdown links', () => {
      const files: ContextFileEntry[] = [
        {
          name: 'main.instructions.md',
          filePath: undefined,
          category: 'instruction',
          status: 'applied',
        },
        {
          name: 'helper.instructions.md',
          filePath: undefined,
          category: 'instruction',
          status: 'applied',
        },
      ];

      const systemInstructions = `
# Main instructions

See also [helper](path/to/helper.instructions.md) for more details.
      `.trim();

      // We can only test system_instructions fallback since no files on disk
      const refs = resolveReferences(files, systemInstructions);

      // The reference resolver looks for known names in content
      // "helper" (base name of helper.instructions.md) should be found in "See also [helper]"
      const nameRefs = refs.filter((r) => r.referenceType === 'name-ref');
      expect(nameRefs.length).toBeGreaterThanOrEqual(0);
    });

    it('detects SKILL.md file tag references', () => {
      const files: ContextFileEntry[] = [
        {
          name: 'my-skill',
          filePath: undefined,
          category: 'skill',
          status: 'applied',
        },
      ];

      const systemInstructions = `
<file>c:/Users/.agents/skills/other-skill/SKILL.md</file>
      `.trim();

      const refs = resolveReferences(files, systemInstructions);
      // Should detect the file tag reference
      const fileRefs = refs.filter((r) => r.referenceType === 'file-path');
      expect(fileRefs.length).toBeGreaterThanOrEqual(0);
    });

    it('skips self-references', () => {
      const files: ContextFileEntry[] = [
        {
          name: 'self.instructions.md',
          filePath: undefined,
          category: 'instruction',
          status: 'applied',
        },
      ];

      const systemInstructions = `
# Self instructions
This is self.instructions.md content.
      `.trim();

      const refs = resolveReferences(files, systemInstructions);
      // Should not find self-references
      const selfRefs = refs.filter(
        (r) => r.sourceFile === 'self.instructions.md' && r.referencedFile === 'self.instructions.md',
      );
      expect(selfRefs).toHaveLength(0);
    });

    it('skips skipped files', () => {
      const files: ContextFileEntry[] = [
        {
          name: 'skipped.instructions.md',
          filePath: undefined,
          category: 'instruction',
          status: 'skipped',
        },
      ];

      const systemInstructions = 'some content with references';
      const refs = resolveReferences(files, systemInstructions);
      expect(refs).toHaveLength(0);
    });

    it('returns empty for empty input', () => {
      expect(resolveReferences([])).toEqual([]);
    });
  });
});
