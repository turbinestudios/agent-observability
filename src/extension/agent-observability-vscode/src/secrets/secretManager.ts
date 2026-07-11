import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { generateSaltHex } from './pseudonymize';

/**
 * Secret-at-rest manager wrapping VS Code {@link vscode.SecretStorage}
 * (OS keychain / Windows Credential Manager / libsecret).
 *
 * Two secrets live here, per the Phase 0 contracts:
 *
 * - **Organization API key** (`docs/architecture/api-auth.md`) — the opaque
 *   `aoa_<keyId>_<secret>` bearer token. Stored ONLY here, never in settings,
 *   files, logs, or diagnostics. Phase 7 reads it to build the `Authorization`
 *   header.
 * - **Pseudonym salt** (`docs/architecture/pseudonymization-strategy.md`) — the
 *   HMAC-SHA256 key used to mint the pseudonymous developer id. It may be an
 *   org-shared salt (recommended Option B) provisioned alongside the API key, or
 *   a per-install random salt generated on first use. It is used PURELY as the
 *   HMAC key and is NEVER transmitted on any networked path.
 *
 * All operations are async because {@link vscode.SecretStorage} is async.
 */
export class SecretManager {
  /** SecretStorage key for the organization API key. */
  static readonly API_KEY = 'agentObservability.apiKey';
  /** SecretStorage key for the pseudonym (HMAC) salt, stored as lowercase hex. */
  static readonly PSEUDONYM_SALT = 'agentObservability.pseudonymSalt';

  private readonly secrets: vscode.SecretStorage;

  constructor(context: vscode.ExtensionContext) {
    this.secrets = context.secrets;
  }

  /** The stored organization API key, or `undefined` when none is set. */
  async getApiKey(): Promise<string | undefined> {
    return this.secrets.get(SecretManager.API_KEY);
  }

  /**
   * Store the organization API key. The caller is responsible for validating the
   * format (`aoa_` prefix etc.) before calling; the value is written verbatim.
   */
  async setApiKey(value: string): Promise<void> {
    await this.secrets.store(SecretManager.API_KEY, value);
  }

  /** Remove the stored organization API key (e.g. on revocation / clear). */
  async clearApiKey(): Promise<void> {
    await this.secrets.delete(SecretManager.API_KEY);
  }

  /** Whether an organization API key is currently stored. */
  async hasApiKey(): Promise<boolean> {
    const value = await this.secrets.get(SecretManager.API_KEY);
    return value !== undefined && value.length > 0;
  }

  /**
   * Return the stored pseudonym salt (hex), generating and persisting a fresh
   * CSPRNG 32-byte salt on first use.
   *
   * Privacy note: this salt is used ONLY as the local HMAC key for minting the
   * pseudonymous developer id. It is never placed in any aggregate batch, log, or
   * diagnostic. Callers must treat the returned value as confidential and must
   * not forward it to any networked path.
   */
  async getOrCreatePseudonymSalt(): Promise<string> {
    const existing = await this.secrets.get(SecretManager.PSEUDONYM_SALT);
    if (existing !== undefined && existing.length > 0) {
      return existing;
    }
    const salt = generateSaltHex();
    await this.secrets.store(SecretManager.PSEUDONYM_SALT, salt);
    return salt;
  }

  /**
   * Overwrite the pseudonym salt with an org-shared value (hex). Provisioning an
   * org-shared salt (per the strategy doc's recommended Option B) makes the same
   * git email resolve to the same developer id across every install in the org,
   * enabling correct cross-machine `ActiveDevelopers` dedup.
   */
  async setPseudonymSalt(hex: string): Promise<void> {
    await this.secrets.store(SecretManager.PSEUDONYM_SALT, hex);
  }

  /** SecretStorage key prefix for per-cloud-account (Copilot Cloud) PAT overrides. */
  static readonly CLOUD_ACCOUNT_TOKEN_PREFIX = 'agentObservability.cloudAccountToken.';

  /**
   * Derive a stable, collision-resistant SecretStorage key for a cloud account
   * label. The label is hashed (SHA-256) so an arbitrary user string cannot alias
   * another account's key under the dotted prefix, and the raw label never leaks
   * into keychain entry names.
   */
  private static cloudAccountKey(accountLabel: string): string {
    const digest = createHash('sha256').update(accountLabel).digest('hex');
    return `${SecretManager.CLOUD_ACCOUNT_TOKEN_PREFIX}${digest}`;
  }

  /** The stored PAT for a cloud account, or `undefined` when none is set. */
  async getCloudAccountToken(accountLabel: string): Promise<string | undefined> {
    return this.secrets.get(SecretManager.cloudAccountKey(accountLabel));
  }

  /** Store a cloud account's PAT. Written verbatim — validate before calling. */
  async setCloudAccountToken(accountLabel: string, value: string): Promise<void> {
    await this.secrets.store(SecretManager.cloudAccountKey(accountLabel), value);
  }

  /** Remove the stored PAT for a cloud account. */
  async clearCloudAccountToken(accountLabel: string): Promise<void> {
    await this.secrets.delete(SecretManager.cloudAccountKey(accountLabel));
  }

  /** Whether a PAT is currently stored for a cloud account. */
  async hasCloudAccountToken(accountLabel: string): Promise<boolean> {
    const value = await this.secrets.get(SecretManager.cloudAccountKey(accountLabel));
    return value !== undefined && value.length > 0;
  }

  /** SecretStorage key for the Copilot (Autonomous) relay bearer token. */
  static readonly AGENT_RELAY_TOKEN = 'agentObservability.agentRelayToken';

  /**
   * The stored bearer token for the autonomous-agent OTLP relay, or `undefined`
   * when none is set. Used ONLY to authenticate the read/pull against the relay's
   * landing spot; never placed in any aggregate batch, log, or diagnostic.
   */
  async getAgentRelayToken(): Promise<string | undefined> {
    return this.secrets.get(SecretManager.AGENT_RELAY_TOKEN);
  }

  /** Store the agent relay token. Written verbatim — validate before calling. */
  async setAgentRelayToken(value: string): Promise<void> {
    await this.secrets.store(SecretManager.AGENT_RELAY_TOKEN, value);
  }

  /** Remove the stored agent relay token. */
  async clearAgentRelayToken(): Promise<void> {
    await this.secrets.delete(SecretManager.AGENT_RELAY_TOKEN);
  }

  /** Whether an agent relay token is currently stored. */
  async hasAgentRelayToken(): Promise<boolean> {
    const value = await this.secrets.get(SecretManager.AGENT_RELAY_TOKEN);
    return value !== undefined && value.length > 0;
  }
}
