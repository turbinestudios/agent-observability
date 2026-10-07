import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SettingsReader, SettingsSubscription } from '@agent-observability/core/src/config/configuration';

/**
 * The desktop implementation of core's {@link SettingsReader}, over a JSON file
 * at `~/.agent-observability/desktop/config.json`.
 *
 * Keys are core's section-relative ids (`claudeCode.enabled`,
 * `aiHelper.backend`, …), so core's `Configuration` — every typed accessor,
 * every default, every clamp — works unchanged against this store. Settings the
 * desktop has no equivalent for simply fall back to those defaults.
 *
 * Writes go through a temp file and a rename so a crash mid-write cannot leave a
 * truncated config behind; the whole file is small enough that rewriting it is
 * cheaper than any incremental scheme.
 */
export class DesktopSettingsReader implements SettingsReader {
  private values: Record<string, unknown>;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly file: string = resolveConfigPath()) {
    this.values = readConfig(file);
  }

  get<T>(key: string, defaultValue: T): T {
    const found = this.values[key];
    return found === undefined ? defaultValue : (found as T);
  }

  onDidChange(listener: () => void): SettingsSubscription {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** Current settings, for handing the whole object to the renderer. */
  all(): Record<string, unknown> {
    return { ...this.values };
  }

  /** Merge a patch, persist it, and notify listeners. */
  update(patch: Record<string, unknown>): void {
    const next = { ...this.values };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        delete next[key];
      } else {
        next[key] = value;
      }
    }
    this.values = next;
    writeConfig(this.file, next);
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export function resolveConfigPath(): string {
  return path.join(os.homedir(), '.agent-observability', 'desktop', 'config.json');
}

function readConfig(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or unreadable config is the normal first-run state; defaults apply.
  }
  return {};
}

function writeConfig(file: string, values: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(values, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
