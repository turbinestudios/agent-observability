import * as vscode from 'vscode';
import { CONFIG_SECTION, SettingsReader, SettingsSubscription } from './configuration';

/**
 * The VS Code implementation of {@link SettingsReader}: reads the
 * `agentObservability` section from workspace configuration.
 *
 * This is the extension's binding for the settings seam — the desktop app
 * supplies its own over a JSON file. Keeping it here is what lets
 * {@link Configuration} stay host-independent.
 */
export class VscodeSettingsReader implements SettingsReader {
  get<T>(key: string, defaultValue: T): T {
    // Read fresh each time so changes apply without caching staleness.
    return vscode.workspace.getConfiguration(CONFIG_SECTION).get<T>(key, defaultValue);
  }

  onDidChange(listener: () => void): SettingsSubscription {
    return vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_SECTION)) {
        listener();
      }
    });
  }
}
