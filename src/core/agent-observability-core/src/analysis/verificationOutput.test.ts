import { describe, expect, it } from 'vitest';
import type { VerificationClass, VerificationOutcome } from './sessionActivity';
import { VERIFICATION_OUTPUT_MAX_CHARS, classifyVerificationOutput, normaliseVerificationOutput } from './verificationOutput';

/**
 * Synthetic outputs only, one per tool family and outcome. The rule under
 * test: a failure marker from any family decides `failed`; `passed` needs a
 * positive marker from a family that fits the class; everything else is
 * `unknown`.
 */
const CASES: [string, VerificationClass, string, VerificationOutcome][] = [
  ['vitest pass', 'test', ' Test Files  3 passed (3)\n      Tests  41 passed (41)\n   Duration  2.1s', 'passed'],
  ['vitest pass with skips', 'test', '      Tests  5 passed | 1 skipped (6)', 'passed'],
  ['vitest fail summary', 'test', ' Test Files  1 failed | 2 passed (3)\n      Tests  1 failed | 40 passed (41)', 'failed'],
  ['vitest FAIL line', 'test', ' FAIL  src/a.test.ts > does a thing\nAssertionError: expected 1 to be 2', 'failed'],
  ['jest pass', 'test', 'Test Suites: 4 passed, 4 total\nTests:       2 skipped, 30 passed, 32 total', 'passed'],
  ['jest fail', 'test', 'Test Suites: 1 failed, 3 passed, 4 total\nTests:       1 failed, 31 passed, 32 total', 'failed'],
  ['pytest pass', 'test', '============ 12 passed, 1 warning in 0.42s ============', 'passed'],
  ['pytest quiet pass', 'test', '12 passed in 0.42s', 'passed'],
  ['pytest fail', 'test', '============ 1 failed, 11 passed in 0.50s ============', 'failed'],
  ['pytest error', 'test', '============ 2 errors in 0.10s ============', 'failed'],
  ['go pass', 'test', 'ok  \texample.com/pkg\t0.012s', 'passed'],
  ['go fail', 'test', '--- FAIL: TestThing (0.00s)\nFAIL\nexit status 1', 'failed'],
  ['cargo test pass', 'test', 'test result: ok. 8 passed; 0 failed; 0 ignored', 'passed'],
  ['cargo test fail', 'test', 'test result: FAILED. 7 passed; 1 failed; 0 ignored', 'failed'],
  ['cargo build pass', 'build', '    Finished `dev` profile [unoptimized] target(s) in 1.20s', 'passed'],
  ['cargo build fail', 'build', 'error[E0308]: mismatched types\nerror: could not compile `x`', 'failed'],
  ['dotnet test pass', 'test', 'Passed!  - Failed:     0, Passed:    12, Skipped:     0, Total:    12', 'passed'],
  ['dotnet test fail', 'test', 'Failed!  - Failed:     1, Passed:    11, Skipped:     0, Total:    12', 'failed'],
  ['dotnet build pass', 'build', 'Build succeeded.\n    0 Warning(s)\n    0 Error(s)', 'passed'],
  ['dotnet build fail', 'build', 'Program.cs(3,1): error CS1002: ; expected\nBuild FAILED.\n    1 Error(s)', 'failed'],
  ['maven pass', 'test', '[INFO] BUILD SUCCESS', 'passed'],
  ['gradle fail', 'build', 'BUILD FAILED in 3s', 'failed'],
  ['tsc fail', 'typecheck', "src/a.ts(3,5): error TS2322: Type 'x' is not assignable.", 'failed'],
  ['tsc found errors', 'typecheck', 'Found 3 errors in 2 files.', 'failed'],
  ['tsc watch pass', 'typecheck', 'Found 0 errors. Watching for file changes.', 'passed'],
  ['eslint pass with warnings', 'lint', '✖ 51 problems (0 errors, 51 warnings)', 'passed'],
  ['eslint fail', 'lint', '✖ 3 problems (2 errors, 1 warning)', 'failed'],
  ['mypy pass', 'typecheck', 'Success: no issues found in 12 source files', 'passed'],
  ['mypy fail', 'typecheck', 'Found 2 errors in 1 file (checked 12 source files)', 'failed'],
  ['ruff pass', 'lint', 'All checks passed!', 'passed'],
  ['vite build pass', 'build', '✓ built in 1.69s', 'passed'],
  ['npm script failure', 'test', 'npm error Lifecycle script `test` failed with error:\nnpm error code 1', 'failed'],
  ['make failure', 'build', 'make: *** [Makefile:12: build] Error 2', 'failed'],
  ['empty', 'test', '', 'unknown'],
  ['whitespace', 'typecheck', '  \n\n', 'unknown'],
  ['banner only', 'typecheck', '> pkg@1.0.0 typecheck\n> tsc --noEmit', 'unknown'],
  ['prose', 'test', 'Running the suite now, please wait', 'unknown'],
];

describe('classifyVerificationOutput', () => {
  it.each(CASES)('%s', (_name, cls, output, expected) => {
    expect(classifyVerificationOutput(cls, output)).toBe(expected);
  });

  it('is not flipped by the word "failed" in a test name on a passing run', () => {
    const output = ' ✓ src/login.test.ts > handles failed logins\n ✓ reports FAIL states to the user\n      Tests  2 passed (2)';
    expect(classifyVerificationOutput('test', output)).toBe('passed');
  });

  it('is not flipped by an error line a test logged on purpose', () => {
    const output = 'error: connection refused (expected by this test)\nstderr | src/a.test.ts\nError: boom\n      Tests  2 passed (2)';
    expect(classifyVerificationOutput('test', output)).toBe('passed');
  });

  it('lets a failure marker from another family decide, whatever the class', () => {
    // A `test` script that type-checks first.
    expect(classifyVerificationOutput('test', 'src/a.ts(1,1): error TS1005: ; expected\n      Tests  2 passed (2)')).toBe('failed');
    // A lint run whose wrapper also ran the tests.
    expect(classifyVerificationOutput('lint', '      Tests  1 failed | 3 passed (4)')).toBe('failed');
  });

  it('takes a pass marker only from a family that fits the class', () => {
    // A test summary proves nothing about a type-check.
    expect(classifyVerificationOutput('typecheck', '      Tests  2 passed (2)')).toBe('unknown');
    expect(classifyVerificationOutput('test', '✓ built in 1.69s')).toBe('unknown');
  });

  it('never passes on the mere absence of failure markers', () => {
    expect(classifyVerificationOutput('test', 'collected 12 items\nrunning...')).toBe('unknown');
    expect(classifyVerificationOutput('lint', 'src/a.ts\n  3:1  warning  no-console')).toBe('unknown');
  });

  it('strips colour codes and reads only the tail', () => {
    const coloured = '\u001b[32m      Tests  4 passed\u001b[39m (4)';
    expect(classifyVerificationOutput('test', coloured)).toBe('passed');
    const earlyFailure = ' FAIL  src/old.test.ts\n' + 'x'.repeat(VERIFICATION_OUTPUT_MAX_CHARS + 10) + '\n      Tests  4 passed (4)';
    expect(normaliseVerificationOutput(earlyFailure).length).toBeLessThanOrEqual(VERIFICATION_OUTPUT_MAX_CHARS);
    expect(classifyVerificationOutput('test', earlyFailure)).toBe('passed');
  });

  it('handles Windows line endings', () => {
    expect(classifyVerificationOutput('test', 'Tests:       3 passed, 3 total\r\nTime: 1s\r\n')).toBe('passed');
  });
});
