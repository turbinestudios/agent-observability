import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Rework rows carry absolute file paths, so they are LOCAL-ONLY in the same
 * class as context-file paths. This pins that no module on a path that leaves
 * the machine (team shard, aggregate batch) reads them.
 */
describe('rework data stays local', () => {
  it('is referenced by no team or aggregate module', () => {
    const core = path.join(__dirname, '..', '..', '..', '..', '..', 'core', 'agent-observability-core', 'src');
    const roots = [
      path.join(__dirname, '..', 'team'),
      path.join(core, 'team'),
      path.join(core, 'aggregate'),
    ];
    const offenders: string[] = [];
    for (const root of roots) {
      expect(fs.existsSync(root)).toBe(true);
      for (const name of fs.readdirSync(root)) {
        if (!name.endsWith('.ts') || name.endsWith('.test.ts')) {
          continue;
        }
        const text = fs.readFileSync(path.join(root, name), 'utf8');
        if (/session_file_edits|fileEdits|files_reedited|reworked_lines|reworkRanking|FileEditStat|reworkedLinesByFile/.test(text)) {
          offenders.push(name);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
