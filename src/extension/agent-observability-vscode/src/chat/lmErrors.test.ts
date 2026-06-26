import { describe, it, expect } from 'vitest';
import { describeLmError, isCancellation, noModelsError } from './lmErrors';

describe('describeLmError', () => {
  it('maps a permission/consent denial to a recoverable retry message', () => {
    const e = describeLmError({ code: 'NoPermissions', message: 'user did not grant access' });
    expect(e.recoverable).toBe(true);
    expect(e.message.toLowerCase()).toContain('copilot');
  });

  it('maps a blocked/content-filter error', () => {
    const e = describeLmError({ code: 'Blocked' });
    expect(e.recoverable).toBe(true);
    expect(e.message.toLowerCase()).toContain('content filter');
  });

  it('maps quota/rate-limit errors', () => {
    const e = describeLmError({ message: 'rate limit exceeded' });
    expect(e.recoverable).toBe(true);
    expect(e.message.toLowerCase()).toContain('quota');
  });

  it('maps a missing model', () => {
    const e = describeLmError({ code: 'NotFound', message: 'no such model' });
    expect(e.recoverable).toBe(true);
    expect(e.message.toLowerCase()).toContain('model');
  });

  it('falls back to a generic non-recoverable message and includes the detail', () => {
    const e = describeLmError({ message: 'socket hang up' });
    expect(e.recoverable).toBe(false);
    expect(e.message.toLowerCase()).toContain('socket hang up');
  });

  it('tolerates non-object errors', () => {
    expect(() => describeLmError('boom')).not.toThrow();
    expect(() => describeLmError(undefined)).not.toThrow();
  });
});

describe('isCancellation', () => {
  it('detects cancellation by name', () => {
    expect(isCancellation({ name: 'Canceled' })).toBe(true);
    expect(isCancellation({ name: 'CancellationError' })).toBe(true);
  });

  it('detects cancellation by message', () => {
    expect(isCancellation({ message: 'Request was cancelled' })).toBe(true);
  });

  it('is false for ordinary errors', () => {
    expect(isCancellation({ code: 'Blocked', message: 'nope' })).toBe(false);
  });
});

describe('noModelsError', () => {
  it('is non-recoverable and mentions Copilot', () => {
    const e = noModelsError();
    expect(e.recoverable).toBe(false);
    expect(e.message.toLowerCase()).toContain('copilot');
  });
});
