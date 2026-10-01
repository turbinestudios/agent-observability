import { describe, it, expect } from 'vitest';
import { Configuration, ConfigKeys, normalizeDashboardUrl, SettingsReader } from './configuration';

/**
 * The dashboard address is the one setting that decides where the bearer API
 * key is sent, so only a well-formed `https:` URL may come out of it. Anything
 * else must read as "not set", which the sync engine reports as misconfigured.
 */

function readerWith(values: Record<string, unknown>): SettingsReader {
  return {
    get<T>(key: string, defaultValue: T): T {
      return key in values ? (values[key] as T) : defaultValue;
    },
    onDidChange: () => ({ dispose: () => undefined }),
  };
}

describe('normalizeDashboardUrl', () => {
  it('treats empty and whitespace-only values as not set', () => {
    expect(normalizeDashboardUrl('')).toBe('');
    expect(normalizeDashboardUrl('   ')).toBe('');
  });

  it('rejects non-string values', () => {
    expect(normalizeDashboardUrl(undefined)).toBe('');
    expect(normalizeDashboardUrl(42)).toBe('');
  });

  it('rejects plain http and other schemes', () => {
    expect(normalizeDashboardUrl('http://dashboard.example.com')).toBe('');
    expect(normalizeDashboardUrl('ftp://dashboard.example.com')).toBe('');
  });

  it('rejects values that are not URLs', () => {
    expect(normalizeDashboardUrl('dashboard.example.com')).toBe('');
  });

  it('trims whitespace and trailing slashes from an https URL', () => {
    expect(normalizeDashboardUrl('  https://dashboard.example.com/  ')).toBe(
      'https://dashboard.example.com',
    );
  });
});

describe('Configuration.getDashboardUrl', () => {
  it('is empty by default, so nothing can upload until the user sets it', () => {
    expect(new Configuration(readerWith({})).getDashboardUrl()).toBe('');
  });

  it('returns the normalized user value', () => {
    const config = new Configuration(
      readerWith({ [ConfigKeys.syncDashboardUrl]: 'https://dashboard.example.com/' }),
    );
    expect(config.getDashboardUrl()).toBe('https://dashboard.example.com');
  });

  it('refuses an http address', () => {
    const config = new Configuration(
      readerWith({ [ConfigKeys.syncDashboardUrl]: 'http://dashboard.example.com' }),
    );
    expect(config.getDashboardUrl()).toBe('');
  });
});
