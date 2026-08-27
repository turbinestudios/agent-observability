import { describe, it, expect } from 'vitest';
import { ClaudeCliError, describeClaudeError } from './claudeErrors';
import { isCancellation } from '../lmErrors';

describe('describeClaudeError', () => {
  it('maps a missing CLI (ENOENT) to a non-recoverable install hint', () => {
    const e = describeClaudeError(new ClaudeCliError('spawn claude ENOENT', { code: 'ENOENT' }));
    expect(e.recoverable).toBe(false);
    expect(e.message).toContain('claudeCliPath');
  });

  it('maps auth failures to a sign-in hint', () => {
    for (const detail of ['Please run /login', 'Authentication failed', 'Invalid API key', '401 unauthorized']) {
      const e = describeClaudeError(new ClaudeCliError(detail));
      expect(e.recoverable).toBe(true);
      expect(e.message.toLowerCase()).toContain('signed in');
    }
  });

  it('maps rate/usage limits to a retry-later message', () => {
    const e = describeClaudeError(new ClaudeCliError('usage limit reached, resets at 5pm'));
    expect(e.recoverable).toBe(true);
    expect(e.message.toLowerCase()).toContain('try again later');
  });

  it('maps an unsupported effort level', () => {
    const e = describeClaudeError(new ClaudeCliError('--effort xhigh is not supported for this model'));
    expect(e.recoverable).toBe(true);
    expect(e.message.toLowerCase()).toContain('effort');
  });

  it('maps an unknown model', () => {
    const e = describeClaudeError(new ClaudeCliError('model claude-nope not found'));
    expect(e.recoverable).toBe(true);
    expect(e.message.toLowerCase()).toContain('model is unavailable');
  });

  it('maps an outdated CLI (unknown option) to an update hint', () => {
    const e = describeClaudeError(
      new ClaudeCliError('failed', { exitCode: 1, stderrTail: "error: unknown option '--effort'" }),
    );
    expect(e.recoverable).toBe(true);
    expect(e.message.toLowerCase()).toContain('update claude code');
  });

  it('falls back to a generic message carrying the detail', () => {
    const e = describeClaudeError(new ClaudeCliError('something exploded'));
    expect(e.recoverable).toBe(false);
    expect(e.message).toContain('something exploded');
  });

  it('tolerates non-object errors', () => {
    expect(() => describeClaudeError('boom')).not.toThrow();
    expect(() => describeClaudeError(undefined)).not.toThrow();
  });
});

describe('cancellation flows past describeClaudeError', () => {
  it('a Canceled-named error is recognized by the shared isCancellation()', () => {
    const err = Object.assign(new Error('Canceled'), { name: 'Canceled' });
    expect(isCancellation(err)).toBe(true);
  });
});
