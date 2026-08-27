import { describe, it, expect } from 'vitest';
import { computeCanSync, describeSyncBlock } from './syncGate';

/**
 * The sync gate is the privacy-critical decision that controls whether ANY
 * upload may happen. These tests pin the Phase 4 exit criteria: opt-out default
 * and the consent-AND-key requirement.
 */
describe('syncGate', () => {
  it('permits sync only when consented AND a key is present', () => {
    expect(computeCanSync({ consented: true, hasApiKey: true })).toBe(true);
  });

  it('blocks when consented but no API key', () => {
    expect(computeCanSync({ consented: true, hasApiKey: false })).toBe(false);
  });

  it('blocks when a key is present but not consented (opt-out default)', () => {
    expect(computeCanSync({ consented: false, hasApiKey: true })).toBe(false);
  });

  it('blocks when neither consent nor key (the default state)', () => {
    expect(computeCanSync({ consented: false, hasApiKey: false })).toBe(false);
  });

  it('describes no block when sync is allowed', () => {
    expect(describeSyncBlock({ consented: true, hasApiKey: true })).toBeUndefined();
  });

  it('explains both missing gates, never leaking a key', () => {
    const both = describeSyncBlock({ consented: false, hasApiKey: false });
    expect(both).toBeDefined();
    expect(both).toMatch(/sharing is off/i);
    expect(both).toMatch(/api key/i);

    expect(describeSyncBlock({ consented: false, hasApiKey: true })).toMatch(/sharing is off/i);
    expect(describeSyncBlock({ consented: true, hasApiKey: false })).toMatch(/api key/i);
  });
});
