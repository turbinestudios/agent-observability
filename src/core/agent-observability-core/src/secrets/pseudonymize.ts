import { createHmac, randomBytes } from 'node:crypto';

/**
 * Local-only developer pseudonymization (SHARED with Phase 5 aggregation).
 *
 * Implements the algorithm fixed by `docs/architecture/pseudonymization-strategy.md`
 * exactly:
 *
 *   normalized  = trim(lowercase(identityInput))
 *   mac         = HMAC-SHA256(key = orgSalt, message = utf8(normalized))
 *   developerId = "dev_" + lowercaseHex(mac[0:16])    // first 16 bytes => 32 hex chars
 *
 * The result is the ONLY identity-derived value that may appear in an outgoing
 * aggregate batch (`pseudonymousDeveloperId`). It satisfies the schema pattern
 * `^dev_[0-9a-f]{32}$` (exactly 36 chars) by construction.
 *
 * This module imports no host API so it can be unit tested headless (like
 * {@link sanitizeRepositoryUrl}). The salt is supplied by the caller (the
 * desktop's per-install team salt file); it is used PURELY as the HMAC key and
 * is NEVER returned, logged, or placed in a shard.
 *
 * The identity `tier` is a LOCAL-ONLY diagnostic and is deliberately excluded
 * from any aggregate batch — the v1 schema has no `tier` field and sets
 * `additionalProperties: false`, so shipping one would reject the whole batch.
 */

/** Length in bytes of a freshly generated org/pseudonym salt (>= 32 per the strategy doc). */
export const SALT_BYTES = 32;

/** Schema-mandated developer id pattern (`^dev_[0-9a-f]{32}$`, exactly 36 chars). */
export const DEVELOPER_ID_PATTERN = /^dev_[0-9a-f]{32}$/;

/**
 * Which ambient identity input produced a developer id. LOCAL-ONLY diagnostic;
 * MUST NOT be attached to any aggregate batch (no schema slot exists for it).
 */
export type IdentityTier = 'email' | 'os_user' | 'machine';

/** A resolved identity input plus the tier marker recording its source. */
export interface IdentityInput {
  /** The raw identity value (e.g. git email, OS username, machineId). */
  value: string;
  /** Which source the value came from (local diagnostic only). */
  tier: IdentityTier;
}

/** A minted developer id together with its local-only tier marker. */
export interface DeveloperIdentity {
  /** `dev_` + 32 lowercase hex chars. Safe to ship as `pseudonymousDeveloperId`. */
  id: string;
  /** LOCAL-ONLY: which input tier produced the id. Never shipped. */
  tier: IdentityTier;
}

/**
 * Generate a fresh CSPRNG org/pseudonym salt and return it as lowercase hex.
 *
 * Used by {@link SecretManager.getOrCreatePseudonymSalt} when no org-shared salt
 * has been provisioned. 32 bytes (256 bits) of entropy per the strategy doc.
 */
export function generateSaltHex(): string {
  return randomBytes(SALT_BYTES).toString('hex');
}

/**
 * Mint the pseudonymous developer id from a hex-encoded org salt and a resolved
 * identity input.
 *
 * @param saltHex hex-encoded salt (the HMAC key) — read from the per-install
 *   salt file, never shared.
 * @param input the resolved identity value + tier.
 * @returns the `dev_<32 hex>` id plus the local-only tier marker.
 */
export function mintDeveloperId(saltHex: string, input: IdentityInput): DeveloperIdentity {
  const salt = Buffer.from(saltHex, 'hex');
  const normalized = input.value.trim().toLowerCase();
  const mac = createHmac('sha256', salt).update(normalized, 'utf8').digest();
  const id = `dev_${mac.subarray(0, 16).toString('hex')}`;
  return { id, tier: input.tier };
}
