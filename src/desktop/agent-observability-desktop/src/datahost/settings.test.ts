import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Configuration } from '@agent-observability/core/src/config/configuration';
import type { ClaudeFs } from '@agent-observability/core/src/claude/paths';
import { DesktopSettingsReader } from './drivers/desktopConfig';
import { applySettingsPatch, buildSettingsSnapshot, type SettingsSeams } from './settings';
import { pickCopilotDatabase } from './indexer/copilotIndexer';

/**
 * The snapshot/patch pair behind the Settings page. Everything runs against a
 * temp config file and injected seams, so nothing scans the real machine.
 */

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-settings-'));
  file = path.join(dir, 'config.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function fakeClaudeFs(existingDirs: string[] = []): ClaudeFs {
  const set = new Set(existingDirs.map((d) => path.normalize(d)));
  return {
    homedir: () => '',
    env: {},
    isDirectory: (p) => set.has(path.normalize(p)),
    readDir: () => [],
    mtimeMs: () => undefined,
  };
}

function seams(over: Partial<SettingsSeams> = {}): SettingsSeams {
  return {
    claudeFs: fakeClaudeFs(),
    pickCopilot: () => undefined,
    exists: () => false,
    configPath: file,
    ...over,
  };
}

describe('buildSettingsSnapshot', () => {
  it('reads pure defaults from an absent config file', () => {
    const settings = new DesktopSettingsReader(file);
    const snapshot = buildSettingsSnapshot(settings, new Configuration(settings), seams());

    expect(snapshot.claudeEnabled).toBe(true);
    expect(snapshot.copilotEnabled).toBe(true);
    expect(snapshot.claudeProjectsPath).toBe('');
    expect(snapshot.sqlitePath).toBe('');
    expect(snapshot.claudeOverrideMissing).toBe(false);
    expect(snapshot.sqliteOverrideMissing).toBe(false);
    expect(snapshot.resolvedClaudeDirs).toEqual([]);
    expect(snapshot.resolvedCopilotDb).toBeUndefined();
    expect(snapshot.configPath).toBe(file);
    expect(snapshot.configDir).toBe(dir);
  });

  it('flags a non-empty override that does not exist on disk', () => {
    const settings = new DesktopSettingsReader(file);
    settings.update({ 'claudeCode.projectsPath': '/nope', sqlitePath: '/gone.db' });
    const snapshot = buildSettingsSnapshot(settings, new Configuration(settings), seams());

    expect(snapshot.claudeOverrideMissing).toBe(true);
    expect(snapshot.sqliteOverrideMissing).toBe(true);
  });

  it('does not flag an override that exists', () => {
    const settings = new DesktopSettingsReader(file);
    settings.update({ 'claudeCode.projectsPath': dir, sqlitePath: file });
    const snapshot = buildSettingsSnapshot(
      settings,
      new Configuration(settings),
      seams({ exists: () => true, claudeFs: fakeClaudeFs([dir]) }),
    );

    expect(snapshot.claudeOverrideMissing).toBe(false);
    expect(snapshot.sqliteOverrideMissing).toBe(false);
    expect(snapshot.resolvedClaudeDirs).toEqual([path.normalize(dir)]);
  });

  it('maps the picked Copilot database onto snapshot kinds', () => {
    const settings = new DesktopSettingsReader(file);
    const config = new Configuration(settings);

    const archive = buildSettingsSnapshot(settings, config, seams({
      pickCopilot: () => ({ path: '/a.db', archive: true, override: false }),
    }));
    expect(archive.resolvedCopilotDb).toEqual({ path: '/a.db', kind: 'archive' });

    const override = buildSettingsSnapshot(settings, config, seams({
      pickCopilot: () => ({ path: '/o.db', archive: false, override: true }),
    }));
    expect(override.resolvedCopilotDb).toEqual({ path: '/o.db', kind: 'override' });

    const native = buildSettingsSnapshot(settings, config, seams({
      pickCopilot: () => ({ path: '/n.db', archive: false, override: false }),
    }));
    expect(native.resolvedCopilotDb).toEqual({ path: '/n.db', kind: 'native' });
  });
});

describe('applySettingsPatch', () => {
  it('persists changed values and reports which domains changed', () => {
    const settings = new DesktopSettingsReader(file);
    const changed = applySettingsPatch(settings, {
      claudeEnabled: false,
      sqlitePath: '  /custom/traces.db  ',
    });

    expect(changed).toEqual({ claude: true, copilot: true });
    // Round-trip through a fresh reader: the write really hit the disk.
    const reread = new DesktopSettingsReader(file);
    expect(reread.get('claudeCode.enabled', true)).toBe(false);
    expect(reread.get('sqlitePath', '')).toBe('/custom/traces.db');
  });

  it('deletes a key when a path is cleared, so auto-detect returns', () => {
    const settings = new DesktopSettingsReader(file);
    settings.update({ sqlitePath: '/custom.db' });
    const changed = applySettingsPatch(settings, { sqlitePath: '' });

    expect(changed.copilot).toBe(true);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect('sqlitePath' in raw).toBe(false);
  });

  it('is a no-op when the patch matches the stored state', () => {
    const settings = new DesktopSettingsReader(file);
    const changed = applySettingsPatch(settings, {
      claudeEnabled: true,
      copilotEnabled: true,
      claudeProjectsPath: '',
      sqlitePath: '',
    });

    expect(changed).toEqual({ claude: false, copilot: false });
    // Nothing changed, so nothing was written — first save is what creates the file.
    expect(fs.existsSync(file)).toBe(false);
  });

  it('ignores values of the wrong runtime type', () => {
    const settings = new DesktopSettingsReader(file);
    const changed = applySettingsPatch(settings, {
      claudeEnabled: 'yes' as unknown as boolean,
      sqlitePath: 42 as unknown as string,
    });

    expect(changed).toEqual({ claude: false, copilot: false });
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('pickCopilotDatabase', () => {
  it('prefers a non-empty archive over the override', () => {
    const archivePath = path.join(dir, 'archive.db');
    const overridePath = path.join(dir, 'override.db');
    fs.writeFileSync(archivePath, 'x');
    fs.writeFileSync(overridePath, 'x');

    const settings = new DesktopSettingsReader(file);
    settings.update({ 'copilotArchive.path': archivePath, sqlitePath: overridePath });
    const picked = pickCopilotDatabase(new Configuration(settings));

    expect(picked).toEqual({ path: path.normalize(archivePath), archive: true, override: false });
  });

  it('falls back to the override when no archive exists', () => {
    const overridePath = path.join(dir, 'override.db');
    fs.writeFileSync(overridePath, 'x');

    const settings = new DesktopSettingsReader(file);
    settings.update({ 'copilotArchive.path': path.join(dir, 'missing.db'), sqlitePath: overridePath });
    const picked = pickCopilotDatabase(new Configuration(settings));

    expect(picked).toEqual({ path: overridePath, archive: false, override: true });
  });

  it('returns undefined when nothing readable exists', () => {
    const settings = new DesktopSettingsReader(file);
    settings.update({
      'copilotArchive.path': path.join(dir, 'missing.db'),
      sqlitePath: path.join(dir, 'also-missing.db'),
    });

    expect(pickCopilotDatabase(new Configuration(settings))).toBeUndefined();
  });
});
