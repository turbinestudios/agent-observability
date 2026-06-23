import { createHmac } from 'node:crypto';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { DEVELOPER_ID_PATTERN, IdentityTier } from '../secrets/pseudonymize';

/**
 * Phase 5 developer pseudonymization for the aggregate engine.
 *
 * Implements the algorithm fixed by `docs/architecture/pseudonymization-strategy.md`
 * EXACTLY:
 *
 *   normalized  = trim(lowercase(identityInput))
 *   mac         = HMAC-SHA256(key = Buffer(saltHex,'hex'), message = utf8(normalized))
 *   developerId = "dev_" + lowercaseHex(mac[0:16])   // first 16 bytes => 32 hex chars
 *
 * The result satisfies the shared schema pattern `^dev_[0-9a-f]{32}$` (exactly 36
 * chars) by construction; an email/username structurally cannot satisfy it.
 *
 * This module never imports `vscode`, so it is headless-testable. The org salt is
 * supplied by the caller (read from SecretStorage); it is used PURELY as the HMAC
 * key and is NEVER returned, logged, or placed on any networked path.
 *
 * The identity {@link IdentityTier} is a LOCAL-ONLY diagnostic. There is NO `tier`
 * slot in the v1 aggregate batch schema (which sets `additionalProperties: false`),
 * so it is never placed in a batch — callers attach only the returned id.
 */

export { DEVELOPER_ID_PATTERN } from '../secrets/pseudonymize';
export type { IdentityTier } from '../secrets/pseudonymize';

/** A resolved local identity input plus the LOCAL-ONLY tier marker. */
export interface ResolvedIdentity {
  /** The raw identity value (git email, OS username, or machine id). NEVER shipped. */
  input: string;
  /** Which source produced the value (local diagnostic only). NEVER shipped. */
  tier: IdentityTier;
}

/**
 * Compute the pseudonymous developer id from a hex-encoded org salt and a raw
 * identity input string.
 *
 * @param saltHex hex-encoded org salt (the HMAC key) — read from SecretStorage,
 *   never transmitted.
 * @param identityInput the raw identity value (e.g. git email). Normalized
 *   (trim + lowercase) before hashing.
 * @returns `dev_` + 32 lowercase hex chars (matches `^dev_[0-9a-f]{32}$`).
 */
export function computeDeveloperId(saltHex: string, identityInput: string): string {
  const salt = Buffer.from(saltHex, 'hex');
  const normalized = identityInput.trim().toLowerCase();
  const mac = createHmac('sha256', salt).update(normalized, 'utf8').digest();
  return `dev_${mac.subarray(0, 16).toString('hex')}`;
}

/**
 * Resolve the local identity input used to mint the developer id, following the
 * strategy doc's fallback order:
 *
 *   1. git `user.email` (effective config, run with `cwd = workspaceCwd`)
 *   2. OS username (`os.userInfo().username`)
 *   3. the provided `machineId` (e.g. `vscode.env.machineId`)
 *
 * The chosen {@link IdentityTier} is returned for LOCAL diagnostics only and MUST
 * NOT be attached to any aggregate batch. The raw `input` likewise never leaves
 * the machine — only the {@link computeDeveloperId} output may be shipped.
 *
 * Never throws: any failure resolving an input falls through to the next tier and
 * finally to a stable literal so a developer id can always be minted locally.
 *
 * @param workspaceCwd optional workspace dir to run `git config` in (so a
 *   repo-local override of `user.email` is honored, matching git's effective
 *   config resolution).
 * @param machineId optional final fallback (the VS Code `machineId`).
 */
export function getIdentityInput(workspaceCwd?: string, machineId?: string): ResolvedIdentity {
  const email = tryGitEmail(workspaceCwd);
  if (email !== undefined) {
    return { input: email, tier: 'email' };
  }

  const username = tryOsUsername();
  if (username !== undefined) {
    return { input: username, tier: 'os_user' };
  }

  // Final fallback: the provided machine id, else a stable literal so a (low
  // confidence) id can still be minted. The tier marks it as machine-derived.
  const machine = machineId !== undefined && machineId.trim().length > 0 ? machineId.trim() : 'unknown-machine';
  return { input: machine, tier: 'machine' };
}

/**
 * Read the effective git `user.email`, or `undefined` when git is missing or the
 * identity is unconfigured. Runs `git config --get user.email` in `cwd` so a
 * repo-local override is reflected. Errors (git absent, non-zero exit) are
 * swallowed — they simply mean "no email available", triggering the next tier.
 */
function tryGitEmail(cwd?: string): string | undefined {
  try {
    const out = execFileSync('git', ['config', '--get', 'user.email'], {
      cwd: cwd && cwd.length > 0 ? cwd : undefined,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      windowsHide: true,
    });
    const email = out.trim();
    return email.length > 0 ? email : undefined;
  } catch {
    return undefined;
  }
}

/** Read the OS username, or `undefined` when unavailable. */
function tryOsUsername(): string | undefined {
  try {
    const name = os.userInfo().username;
    return typeof name === 'string' && name.trim().length > 0 ? name.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Convenience: resolve identity locally and compute its developer id in one call. */
export function resolveDeveloperId(
  saltHex: string,
  workspaceCwd?: string,
  machineId?: string,
): { id: string; tier: IdentityTier } {
  const { input, tier } = getIdentityInput(workspaceCwd, machineId);
  return { id: computeDeveloperId(saltHex, input), tier };
}

/** Re-exported for callers/tests that assert the produced id shape. */
export const DEV_ID_PATTERN = DEVELOPER_ID_PATTERN;
