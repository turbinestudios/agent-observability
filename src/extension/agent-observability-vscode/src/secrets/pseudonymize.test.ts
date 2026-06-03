import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHmac } from 'node:crypto';
import {
  mintDeveloperId,
  generateSaltHex,
  DEVELOPER_ID_PATTERN,
  SALT_BYTES,
  IdentityInput,
} from './pseudonymize';

/**
 * Privacy-critical pseudonymization tests. The minted developer id is the ONLY
 * identity-derived value that may be shipped, so it must (a) match the shared
 * schema pattern exactly, (b) be deterministic per (salt, email), (c) be
 * salt-sensitive (different orgs => different ids), and (d) never leak the raw
 * input or the salt.
 */

// Load the canonical dev-id pattern straight from the shared schema so this test
// fails if the producer-side pattern ever drifts from the contract.
interface AggregateSchema {
  properties: { pseudonymousDeveloperId: { pattern: string; minLength: number; maxLength: number } };
}
const schema = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../../schemas/aggregate-batch.schema.json'), 'utf8'),
) as AggregateSchema;
const SCHEMA_DEV_ID_PATTERN = new RegExp(schema.properties.pseudonymousDeveloperId.pattern);

// A fixed salt for deterministic assertions (hex of 32 bytes).
const SALT_A = 'a'.repeat(64);
const SALT_B = 'b'.repeat(64);

const email = (v: string): IdentityInput => ({ value: v, tier: 'email' });

describe('mintDeveloperId', () => {
  it('produces an id matching both the local and shared schema pattern (exactly 36 chars)', () => {
    const { id } = mintDeveloperId(SALT_A, email('ada@contoso.com'));
    expect(id).toHaveLength(36);
    expect(DEVELOPER_ID_PATTERN.test(id)).toBe(true);
    expect(SCHEMA_DEV_ID_PATTERN.test(id)).toBe(true);
    expect(schema.properties.pseudonymousDeveloperId.minLength).toBe(36);
    expect(schema.properties.pseudonymousDeveloperId.maxLength).toBe(36);
  });

  it('matches the reference algorithm: dev_ + first 16 bytes of HMAC-SHA256(salt, normalized) as hex', () => {
    const normalized = 'ada@contoso.com';
    const mac = createHmac('sha256', Buffer.from(SALT_A, 'hex'))
      .update(normalized, 'utf8')
      .digest();
    const expected = `dev_${mac.subarray(0, 16).toString('hex')}`;
    expect(mintDeveloperId(SALT_A, email(normalized)).id).toBe(expected);
  });

  it('normalizes input: trims and lowercases before hashing', () => {
    const canonical = mintDeveloperId(SALT_A, email('ada@contoso.com')).id;
    expect(mintDeveloperId(SALT_A, email('  Ada@Contoso.com ')).id).toBe(canonical);
    expect(mintDeveloperId(SALT_A, email('ADA@CONTOSO.COM')).id).toBe(canonical);
  });

  it('is deterministic for the same (salt, input)', () => {
    expect(mintDeveloperId(SALT_A, email('dev@x.io')).id).toBe(
      mintDeveloperId(SALT_A, email('dev@x.io')).id,
    );
  });

  it('is salt-sensitive: a different org salt yields a different id (not cross-org correlatable)', () => {
    expect(mintDeveloperId(SALT_A, email('dev@x.io')).id).not.toBe(
      mintDeveloperId(SALT_B, email('dev@x.io')).id,
    );
  });

  it('is collision-resistant across distinct inputs under the same salt', () => {
    const a = mintDeveloperId(SALT_A, email('ada@contoso.com')).id;
    const b = mintDeveloperId(SALT_A, email('bob@contoso.com')).id;
    expect(a).not.toBe(b);
  });

  it('never embeds the raw identity input or the salt in the id', () => {
    const raw = 'ada@contoso.com';
    const { id } = mintDeveloperId(SALT_A, email(raw));
    expect(id).not.toContain(raw);
    expect(id).not.toContain('ada');
    expect(id).not.toContain('@');
    expect(id).not.toContain(SALT_A);
  });

  it('preserves the local-only tier marker (which must never be shipped)', () => {
    expect(mintDeveloperId(SALT_A, { value: 'host-user', tier: 'os_user' }).tier).toBe('os_user');
    expect(mintDeveloperId(SALT_A, { value: 'machine-xyz', tier: 'machine' }).tier).toBe('machine');
  });
});

describe('generateSaltHex', () => {
  it('returns 32 bytes (256 bits) of CSPRNG entropy as 64 hex chars', () => {
    const salt = generateSaltHex();
    expect(salt).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(salt, 'hex')).toHaveLength(SALT_BYTES);
  });

  it('returns a fresh value each call', () => {
    expect(generateSaltHex()).not.toBe(generateSaltHex());
  });
});
