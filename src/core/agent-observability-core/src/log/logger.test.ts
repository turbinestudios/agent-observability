import { describe, it, expect } from 'vitest';
import { NoopLogger, errorMessage } from './logger';

describe('errorMessage', () => {
  it('returns an Error instance message verbatim', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('stringifies non-Error values', () => {
    expect(errorMessage('plain string')).toBe('plain string');
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage(undefined)).toBe('undefined');
  });
});

describe('NoopLogger', () => {
  it('accepts every level without throwing', () => {
    const log = new NoopLogger();
    expect(() => {
      log.debug('d');
      log.info('i');
      log.warn('w');
      log.error('e', new Error('x'));
    }).not.toThrow();
  });
});
