import * as vscode from 'vscode';
import { computeCanSync } from './syncGate';

/**
 * Cloud-sharing consent gate.
 *
 * Consent is the user's explicit opt-in to upload aggregated, non-sensitive
 * statistics. It is **opt-out by default** (`false`) and stored in the
 * extension's {@link vscode.ExtensionContext.globalState} so it is per-user and
 * survives restarts without being a synced workspace setting.
 *
 * Consent alone is not sufficient to sync — an organization API key must also be
 * present. {@link ConsentManager.canSync} combines both gates; Phase 7's sync
 * engine and the `syncNow` command consult it before any upload.
 */
export class ConsentManager {
  /** globalState key for the cloud-sharing consent flag. */
  static readonly CONSENT_KEY = 'agentObservability.consent.cloudSharing';

  private readonly _onDidChange = new vscode.EventEmitter<boolean>();
  /** Fires with the new consent value whenever {@link setConsent} changes it. */
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Whether the user has opted in to cloud sharing. Defaults to `false`. */
  isConsented(): boolean {
    return this.context.globalState.get<boolean>(ConsentManager.CONSENT_KEY, false);
  }

  /**
   * Persist a new consent value and, when it actually changes, fire
   * {@link onDidChange} so views/commands can refresh.
   */
  async setConsent(value: boolean): Promise<void> {
    const previous = this.isConsented();
    await this.context.globalState.update(ConsentManager.CONSENT_KEY, value);
    if (previous !== value) {
      this._onDidChange.fire(value);
    }
  }

  /**
   * The full sync gate: sharing is permitted only when the user has consented
   * AND an organization API key is present. Both conditions are required by the
   * Phase 4 exit criteria and by `api-auth.md` (sync blocked when consent is off
   * OR no key is present).
   */
  async canSync(secrets: { hasApiKey(): Promise<boolean> }): Promise<boolean> {
    return computeCanSync({
      consented: this.isConsented(),
      hasApiKey: await secrets.hasApiKey(),
    });
  }

  /** Dispose the change emitter. */
  dispose(): void {
    this._onDidChange.dispose();
  }
}
