import * as vscode from 'vscode';
import { Logger, errorMessage } from './logger';

/**
 * The concrete {@link Logger} backed by a VS Code LogOutputChannel — the
 * "Agent Observability" entry in the Output panel.
 *
 * The `{ log: true }` channel gives leveled methods, automatic ISO timestamps,
 * and honors the user's log level (Developer: Set Log Level…) for free, so we do
 * not manage levels or formatting ourselves. Only the vscode-coupled modules
 * (extension.ts, commands) construct this; services depend on the {@link Logger}
 * interface and stay headless-testable.
 *
 * Disposable: the extension pushes it onto `context.subscriptions`.
 */
export class OutputChannelLogger implements Logger, vscode.Disposable {
  private readonly channel: vscode.LogOutputChannel;

  constructor(name = 'Agent Observability') {
    this.channel = vscode.window.createOutputChannel(name, { log: true });
  }

  debug(message: string): void {
    this.channel.debug(message);
  }

  info(message: string): void {
    this.channel.info(message);
  }

  warn(message: string): void {
    this.channel.warn(message);
  }

  error(message: string, err?: unknown): void {
    this.channel.error(err === undefined ? message : `${message}: ${errorMessage(err)}`);
  }

  /** Reveal the channel in the Output panel (backs the "Show Logs" command). */
  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
