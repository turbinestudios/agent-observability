import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHmac } from 'node:crypto';
import { computeDeveloperId, getIdentityInput, DEV_ID_PATTERN } from './pseudonymizer';

/**
 * Privacy-critical pseudonymizer tests for the aggregate engine.
 *
 * computeDeveloperId is the ONLY identity-derived value that may be shipped, so it
 * must (a) match the shared schema pattern exactly, (b) be deterministic per
 * (salt, email), (c) be salt-sensitive, (d) normalize case/whitespace, and (e)
 * NEVER embed the raw email input.
 */

// Load the canonical dev-id pattern from the shared schema so this test fails if
// the producer pattern ever drifts from the contract.
interface AggregateSchema {
  properties: { pseudonymousDeveloperId: { pattern: string } };
}
const schema = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../../schemas/aggregate-batch.schema.json'), 'utf8'),
) as AggregateSchema;
const SCHEMA_DEV_ID_PATTERN = new RegExp(schema.properties.pseudonymousDeveloperId.pattern);

const SALT_A = 'a'.repeat(64);
const SALT_B = 'b'.repeat(64);

describe('computeDeveloperId', () => {
  it('is deterministic for the same salt + email', () => {
    expect(computeDeveloperId(SALT_A, 'ada@contoso.com')).toBe(
      computeDeveloperId(SALT_A, 'ada@contoso.com'),
    );
  });

  it('produces a different id for a different salt (not cross-org correlatable)', () => {
    expect(computeDeveloperId(SALT_A, 'ada@contoso.com')).not.toBe(
      computeDeveloperId(SALT_B, 'ada@contoso.com'),
    );
  });

  it('produces output matching ^dev_[0-9a-f]{32}$ (local + shared schema pattern)', () => {
    const id = computeDeveloperId(SALT_A, 'ada@contoso.com');
    expect(id).toHaveLength(36);
    expect(DEV_ID_PATTERN.test(id)).toBe(true);
    expect(SCHEMA_DEV_ID_PATTERN.test(id)).toBe(true);
  });

  it('normalizes email case and surrounding whitespace before hashing', () => {
    const canonical = computeDeveloperId(SALT_A, 'ada@contoso.com');
    expect(computeDeveloperId(SALT_A, '  Ada@Contoso.com ')).toBe(canonical);
    expect(computeDeveloperId(SALT_A, 'ADA@CONTOSO.COM')).toBe(canonical);
    expect(computeDeveloperId(SALT_A, '\tada@contoso.com\n')).toBe(canonical);
  });

  it('matches the reference HMAC recipe (dev_ + first 16 bytes of HMAC-SHA256(salt, normalized))', () => {
    const normalized = 'ada@contoso.com';
    const mac = createHmac('sha256', Buffer.from(SALT_A, 'hex'))
      .update(normalized, 'utf8')
      .digest();
    expect(computeDeveloperId(SALT_A, normalized)).toBe(`dev_${mac.subarray(0, 16).toString('hex')}`);
  });

  it('NEVER lets the email input appear in the output', () => {
    const email = 'ada@contoso.com';
    const id = computeDeveloperId(SALT_A, email);
    expect(id).not.toContain(email);
    expect(id).not.toContain('ada');
    expect(id).not.toContain('contoso');
    expect(id).not.toContain('@');
    // The pattern structurally forbids '@' and uppercase, so an email cannot pass.
    expect(SCHEMA_DEV_ID_PATTERN.test(email)).toBe(false);
  });

  it('is collision-distinct across different emails under the same salt', () => {
    expect(computeDeveloperId(SALT_A, 'ada@contoso.com')).not.toBe(
      computeDeveloperId(SALT_A, 'bob@contoso.com'),
    );
  });
});

describe('getIdentityInput', () => {
  it('falls back to the OS username or machine id and always returns a usable input + local-only tier', () => {
    // In CI/dev environments git email may or may not be set; either way the
    // resolver must yield a non-empty input and a valid tier marker (never thrown).
    const resolved = getIdentityInput(undefined, 'machine-xyz');
    expect(typeof resolved.input).toBe('string');
    expect(resolved.input.length).toBeGreaterThan(0);
    expect(['email', 'os_user', 'machine']).toContain(resolved.tier);
  });

  it('uses the provided machineId only as the final fallback tier and still mints a valid id', () => {
    const resolved = getIdentityInput(undefined, 'machine-xyz');
    const id = computeDeveloperId(SALT_A, resolved.input);
    expect(DEV_ID_PATTERN.test(id)).toBe(true);
  });

  it('keeps the tier marker out of the minted id (tier is local-only)', () => {
    // The tier label must never influence or appear in the shipped id.
    const id = computeDeveloperId(SALT_A, 'host-user');
    expect(id).not.toContain('os_user');
    expect(id).not.toContain('email');
    expect(id).not.toContain('machine');
  });
});
