import * as vscode from 'vscode';

/**
 * Loads the baked-in `context/*.md` grounding files shipped with the extension.
 *
 * Files live OUTSIDE `src/` at the extension root `context/` directory so they
 * ship in the `.vsix` (`.vscodeignore` excludes `src/**` and `*.ts`, not `*.md`).
 * They are read at runtime via the workspace filesystem API from
 * {@link vscode.ExtensionContext.extensionUri} — the same bundled-asset pattern
 * the chat participant uses for `media/activity-bar.svg`.
 *
 * Decoded contents are cached for the life of the loader; the files are static.
 */
export class ContextLoader {
  private readonly cache = new Map<string, string>();

  constructor(private readonly extensionUri: vscode.Uri) {}

  /** Read and cache one context file by base name (e.g. `workflow-dsl.md`). */
  async load(name: string): Promise<string> {
    const cached = this.cache.get(name);
    if (cached !== undefined) {
      return cached;
    }
    const uri = vscode.Uri.joinPath(this.extensionUri, 'context', name);
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = new TextDecoder('utf-8').decode(bytes);
    this.cache.set(name, text);
    return text;
  }

  /**
   * Load several context files and concatenate them under `## <name>` delimiters,
   * preserving order. Missing files are skipped (a missing asset must never break
   * a turn); at least the present files still ground the request.
   */
  async loadMany(names: readonly string[]): Promise<string> {
    const parts: string[] = [];
    for (const name of names) {
      try {
        parts.push(await this.load(name));
      } catch {
        // A missing/unreadable context file degrades gracefully — skip it.
      }
    }
    return parts.join('\n\n');
  }
}
