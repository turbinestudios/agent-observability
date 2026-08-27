import * as vscode from 'vscode';
import { FileWatchFactory, WatchHandle } from '@agent-observability/core/src/live/claudeWatcher';

/**
 * {@link FileWatchFactory} backed by vscode's `createFileSystemWatcher`.
 *
 * A {@link vscode.RelativePattern} whose base is an absolute folder Uri makes the
 * watch RECURSIVE and works for paths OUTSIDE the workspace (e.g. `~/.claude`),
 * which is exactly what we need — Claude's transcripts live under the home
 * directory, not the open project. We coalesce create/change/delete into the
 * single `onEvent` the watcher cares about.
 */
export const vscodeFileWatchFactory: FileWatchFactory = {
  watch(dir: string, onEvent: (changedPath: string) => void): WatchHandle {
    const pattern = new vscode.RelativePattern(vscode.Uri.file(dir), '**/*.jsonl');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const fire = (uri: vscode.Uri): void => onEvent(uri.fsPath);
    const subs = [
      watcher.onDidCreate(fire),
      watcher.onDidChange(fire),
      watcher.onDidDelete(fire),
      watcher,
    ];
    return {
      dispose: () => {
        for (const sub of subs) {
          sub.dispose();
        }
      },
    };
  },
};
