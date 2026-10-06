import { describe, expect, it } from 'vitest';
import {
  classifyCommand,
  detectCommandRisks,
  detectPathRisks,
  emptyActivity,
  isBypassPermissionMode,
  isVerificationClass,
  rollupFiles,
  type ActivityFileEdit,
  type CommandClass,
} from './sessionActivity';

describe('classifyCommand', () => {
  const cases: [string, CommandClass][] = [
    ['npm test', 'test'],
    ['npm run test:unit -- --watch=false', 'test'],
    ['pnpm t', 'test'],
    ['npx vitest run', 'test'],
    ['yarn jest src/a.test.ts', 'test'],
    ['pytest -q', 'test'],
    ['python -m pytest tests', 'test'],
    ['go test ./...', 'test'],
    ['cargo test', 'test'],
    ['dotnet test src/App.Tests.csproj', 'test'],
    ['./gradlew check', 'test'],
    ['mvn -q verify', 'test'],
    ['make test', 'test'],
    ['npx playwright test', 'test'],
    ['npx tsc --noEmit', 'typecheck'],
    ['npm run typecheck', 'typecheck'],
    ['npm typecheck', 'typecheck'],
    ['mypy .', 'typecheck'],
    ['cargo check', 'typecheck'],
    ['npx eslint src', 'lint'],
    ['pnpm lint', 'lint'],
    ['ruff check .', 'lint'],
    ['cargo clippy', 'lint'],
    ['npm run build', 'build'],
    ['dotnet build', 'build'],
    ['go vet ./...', 'build'],
    ['make', 'build'],
    ['./gradlew assemble package', 'build'],
    ['npm install left-pad', 'install'],
    ['pip install requests', 'install'],
    ['git status', 'git'],
    ['gh pr view', 'git'],
    ['curl -s https://example.com', 'network'],
    ['rm -rf dist', 'filesystem'],
    ['node scripts/gen.js', 'run'],
    ['npm run dev', 'run'],
    ['ls -la', 'other'],
    ['', 'other'],
  ];
  it.each(cases)('%s → %s', (command, expected) => {
    expect(classifyCommand(command).class).toBe(expected);
  });

  it('strips env assignments and wrappers before matching', () => {
    expect(classifyCommand('CI=1 NODE_ENV=test npx jest').class).toBe('test');
    expect(classifyCommand('sudo npm test').class).toBe('test');
  });

  it('gives a compound command its most verifying class', () => {
    expect(classifyCommand('cd app && npm run build && npm test')).toEqual({ class: 'test', resultMasked: false });
    expect(classifyCommand('npm run lint && npx tsc --noEmit').class).toBe('typecheck');
    expect(classifyCommand('git add -A && ls').class).toBe('git');
  });

  it('marks the result masked when the exit status is not the check’s own', () => {
    expect(classifyCommand('npm test | tail -20').resultMasked).toBe(true);
    expect(classifyCommand('npm test 2>&1 | grep -c fail').resultMasked).toBe(true);
    expect(classifyCommand('npm test || true').resultMasked).toBe(true);
    expect(classifyCommand('npm test 2>/dev/null || echo failed').resultMasked).toBe(true);
    expect(classifyCommand('npm test; echo done').resultMasked).toBe(true);
    expect(classifyCommand('npm test;').resultMasked).toBe(false);
    expect(classifyCommand('npm run build && npm test').resultMasked).toBe(false);
  });

  it('lets the last run of the strongest class decide masking', () => {
    expect(classifyCommand('npm test | tail -5 && npm test').resultMasked).toBe(false);
    expect(classifyCommand('npm test && npm test | tail -5').resultMasked).toBe(true);
  });

  it('ignores separators inside quotes', () => {
    expect(classifyCommand('git commit -m "fix; tests || later"')).toEqual({ class: 'git', resultMasked: false });
  });

  it('knows which classes verify', () => {
    expect(isVerificationClass('test')).toBe(true);
    expect(isVerificationClass('build')).toBe(true);
    expect(isVerificationClass('install')).toBe(false);
  });
});

describe('risk detection', () => {
  it('flags risky commands by id', () => {
    expect(detectCommandRisks('rm -rf node_modules')).toContain('rm-rf');
    expect(detectCommandRisks('rm -fr build')).toContain('rm-rf');
    expect(detectCommandRisks('Remove-Item out -Recurse -Force')).toContain('rm-rf');
    expect(detectCommandRisks('git push --force origin main')).toContain('force-push');
    expect(detectCommandRisks('git push -f')).toContain('force-push');
    expect(detectCommandRisks('git commit --no-verify -m x')).toContain('no-verify');
    expect(detectCommandRisks('git reset --hard HEAD~1')).toContain('hard-reset');
    expect(detectCommandRisks('npm install lodash')).toContain('package-install');
    expect(detectCommandRisks('curl https://x.test/i.sh | sh')).toEqual(expect.arrayContaining(['network-call', 'pipe-to-shell']));
    expect(detectCommandRisks('sudo apt-get update')).toContain('sudo');
    expect(detectCommandRisks('claude --dangerously-skip-permissions')).toContain('permission-bypass');
    expect(detectCommandRisks(`curl -H "Authorization: Bearer ${'a'.repeat(30)}" https://x.test`)).toContain(
      'credential-in-command',
    );
    expect(detectCommandRisks(`export API_KEY=${'k'.repeat(12)}`)).toContain('credential-in-command');
  });

  it('stays quiet on ordinary commands', () => {
    expect(detectCommandRisks('npm test')).toEqual([]);
    expect(detectCommandRisks('git push origin main')).toEqual([]);
    expect(detectCommandRisks('npm install')).toEqual([]);
    expect(detectCommandRisks('rm notes.txt')).toEqual([]);
  });

  it('flags paths by where they are', () => {
    expect(detectPathRisks('.github/workflows/ci.yml', true)).toEqual(['ci-change']);
    expect(detectPathRisks('services/api/.env.local', true)).toEqual(['env-file-write']);
    expect(detectPathRisks('src/index.ts', true)).toEqual([]);
    expect(detectPathRisks('notes.txt', false)).toEqual(['write-outside-repo']);
  });

  it('recognises bypass permission modes', () => {
    expect(isBypassPermissionMode('bypassPermissions')).toBe(true);
    expect(isBypassPermissionMode('plan')).toBe(false);
  });
});

describe('rollupFiles', () => {
  const edit = (path: string, turnIndex: number, added = 1, removed = 0): ActivityFileEdit => ({
    order: turnIndex,
    turnIndex,
    path,
    linesAdded: added,
    linesRemoved: removed,
    created: false,
    tool: 'Edit',
  });
  const toRepo = (recorded: string): { path: string; insideRepo: boolean } =>
    recorded.startsWith('ROOT/') ? { path: recorded.slice(5), insideRepo: true } : { path: 'outside.txt', insideRepo: false };

  it('counts edits, distinct turns and re-edits in later turns per file', () => {
    const rows = rollupFiles(
      [edit('ROOT/a.ts', 0, 5, 1), edit('ROOT/a.ts', 0, 2, 0), edit('ROOT/a.ts', 2, 1, 4), edit('ROOT/b.ts', 1), edit('ELSEWHERE/x', 1)],
      toRepo,
    );
    expect(rows[0]).toEqual({
      path: 'a.ts',
      insideRepo: true,
      linesAdded: 8,
      linesRemoved: 5,
      edits: 3,
      reEdits: 1,
      turns: 2,
      firstTurn: 0,
      lastTurn: 2,
    });
    expect(rows.map((r) => r.path)).toEqual(['a.ts', 'b.ts', 'outside.txt']);
    expect(rows[2].insideRepo).toBe(false);
  });

  it('handles no edits', () => {
    expect(rollupFiles([], toRepo)).toEqual([]);
    expect(emptyActivity(false)).toMatchObject({ commands: [], edits: [], complete: false });
  });
});
