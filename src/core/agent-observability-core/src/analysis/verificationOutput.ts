import type { VerificationClass, VerificationOutcome } from './sessionActivity';

/**
 * Read a check's RESULT from what it printed, for the cases where the tool
 * call's error flag is not the check's exit status: agents routinely write
 * `npm test 2>&1 | tail -30` or `tsc --noEmit | grep "error TS"`, and then the
 * flag belongs to `tail` or `grep`.
 *
 * Pure and table-driven. Two rules keep it honest:
 *
 * - **A failure marker from ANY tool family decides `failed`**, whatever the
 *   command's class: a `test` script that first type-checks can fail on a
 *   `error TS…` line.
 * - **`passed` needs a POSITIVE pass marker from a family that fits the
 *   class.** Absence of failure markers is never a pass here. (The two
 *   absence-based passes live in the caller and are deliberately narrow: an
 *   unmasked command whose tool call did not error, and a silent-on-success
 *   type-check or lint behind a truncation-only pipe.)
 *
 * Markers are anchored to summary lines, never bare words, so a test named
 * "handles failed logins" cannot flip a passing run. The output text is raw
 * session content: it is read in memory here and only the three-valued result
 * leaves.
 */

/** Only the tail of the output is scanned; summaries are printed last. */
export const VERIFICATION_OUTPUT_MAX_CHARS = 6000;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export interface VerificationOutputRule {
  family: string;
  /** Classes whose PASS markers this family may supply. Failure markers apply to every class. */
  classes: readonly VerificationClass[];
  failed: readonly RegExp[];
  passed: readonly RegExp[];
}

export const VERIFICATION_OUTPUT_RULES: readonly VerificationOutputRule[] = [
  {
    family: 'vitest',
    classes: ['test'],
    failed: [/^\s*Test Files\s+[^\n]*\b[1-9]\d* failed\b/m, /^\s*Tests\s+[^\n]*\b[1-9]\d* failed\b/m, /^\s*FAIL\s+\S/m],
    passed: [/^\s*Tests\s+[1-9]\d* passed\b/m, /^\s*Test Files\s+[1-9]\d* passed\b/m],
  },
  {
    family: 'jest',
    classes: ['test'],
    failed: [/^Tests:\s+[^\n]*\b[1-9]\d* failed\b/m, /^Test Suites:\s+[^\n]*\b[1-9]\d* failed\b/m],
    passed: [/^Tests:\s+(?:\d+ (?:skipped|todo), )*[1-9]\d* passed, \d+ total/m],
  },
  {
    family: 'pytest',
    classes: ['test'],
    failed: [/^=+ [^\n]*\b[1-9]\d* (?:failed|errors?)\b[^\n]* in [\d.]+s/m, /^[1-9]\d* (?:failed|errors?)\b[^\n]* in [\d.]+s/m],
    passed: [/^=+ [1-9]\d* passed\b[^\n]* in [\d.]+s/m, /^[1-9]\d* passed\b[^\n]* in [\d.]+s/m],
  },
  {
    family: 'go',
    classes: ['test', 'build'],
    failed: [/^--- FAIL\b/m, /^FAIL(?:\s|$)/m],
    passed: [/^ok\s+\S+/m, /^PASS$/m],
  },
  {
    family: 'cargo',
    classes: ['test', 'build', 'typecheck', 'lint'],
    // Not a bare `error:` line: tests log those on purpose, and a failure
    // marker also overrides a clean exit status.
    failed: [/\btest result: FAILED\b/, /^error\[E\d{4}\]:/m, /^error: could not compile\b/m],
    passed: [/\btest result: ok\./, /^\s*Finished [^\n]*target\(s\) in\b/m],
  },
  {
    family: 'dotnet',
    classes: ['test', 'build'],
    failed: [
      /^Failed!\s+-/m,
      /\bBuild FAILED\b/,
      /\berror (?:CS|MSB|NU|FS|BC)\d+\b/,
      /^\s*[1-9]\d* Error\(s\)/m,
      /\bTest summary: total: \d+, failed: [1-9]/,
    ],
    passed: [/^Passed!\s+-/m, /\bBuild succeeded\b/, /\bTest summary: total: \d+, failed: 0, succeeded: [1-9]/],
  },
  {
    family: 'maven-gradle',
    classes: ['test', 'build'],
    failed: [/\bBUILD (?:FAILURE|FAILED)\b/],
    passed: [/\bBUILD SUCCESS(?:FUL)?\b/],
  },
  {
    family: 'typescript',
    classes: ['typecheck', 'build'],
    failed: [/\berror TS\d+:/, /\bFound [1-9]\d* errors?\b/],
    passed: [/\bFound 0 errors\b/],
  },
  {
    family: 'eslint',
    classes: ['lint'],
    failed: [/✖ \d+ problems? \([1-9]\d* errors?/, /\b[1-9]\d* errors? and \d+ warnings? potentially fixable\b/],
    passed: [/✖ \d+ problems? \(0 errors/],
  },
  {
    family: 'python-static',
    classes: ['typecheck', 'lint'],
    failed: [/^Found [1-9]\d* errors? in \d+ files?/m, /^Found [1-9]\d* errors?\./m, /^[1-9]\d* errors?, \d+ warnings?/m],
    passed: [/^Success: no issues found\b/m, /^All checks passed!/m, /^0 errors, \d+ warnings?/m],
  },
  {
    family: 'bundlers',
    classes: ['build'],
    failed: [/\berror during build\b/i, /\bBuild failed with [1-9]\d* errors?\b/, /\bcompiled with [1-9]\d* errors?\b/i],
    passed: [/✓ built in [\d.]+\s?m?s\b/, /\bcompiled successfully\b/i],
  },
  {
    family: 'runners',
    classes: [],
    failed: [/^npm (?:ERR!|error) /m, /^make(?:\[\d+\])?: \*\*\* [^\n]*\bError \d+/m, /\bELIFECYCLE\b/],
    passed: [],
  },
];

/** The scanned tail of an output, colour codes removed and line endings normalised. */
export function normaliseVerificationOutput(output: string): string {
  const tail = output.length > VERIFICATION_OUTPUT_MAX_CHARS ? output.slice(-VERIFICATION_OUTPUT_MAX_CHARS) : output;
  return tail.replace(ANSI, '').replace(/\r\n?/g, '\n');
}

/** What a verification command's own output says about its result. */
export function classifyVerificationOutput(cls: VerificationClass, output: string): VerificationOutcome {
  const text = normaliseVerificationOutput(output);
  if (text.trim().length === 0) {
    return 'unknown';
  }
  for (const rule of VERIFICATION_OUTPUT_RULES) {
    if (rule.failed.some((pattern) => pattern.test(text))) {
      return 'failed';
    }
  }
  for (const rule of VERIFICATION_OUTPUT_RULES) {
    if (rule.classes.includes(cls) && rule.passed.some((pattern) => pattern.test(text))) {
      return 'passed';
    }
  }
  return 'unknown';
}
