import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Configuration } from '@agent-observability/core/src/config/configuration';
import type { ClaudeFs } from '@agent-observability/core/src/claude/paths';
import { DesktopSettingsReader } from './drivers/desktopConfig';
import { applySettingsPatch, buildSettingsSnapshot, type SettingsSeams } from './settings';
import { pickCopilotDatabase, pickCopilotDatabases } from './indexer/copilotIndexer';

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
    pickCopilots: () => [],
    copilotCandidates: () => [],
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
    expect(snapshot.resolvedCopilotDbs).toEqual([]);
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

  it('maps the picked Copilot databases onto snapshot kinds', () => {
    const settings = new DesktopSettingsReader(file);
    const config = new Configuration(settings);

    const archive = buildSettingsSnapshot(settings, config, seams({
      pickCopilots: () => [{ path: '/a.db', archive: true, override: false }],
    }));
    expect(archive.resolvedCopilotDbs).toEqual([{ path: '/a.db', kind: 'archive' }]);

    const override = buildSettingsSnapshot(settings, config, seams({
      pickCopilots: () => [{ path: '/o.db', archive: false, override: true }],
    }));
    expect(override.resolvedCopilotDbs).toEqual([{ path: '/o.db', kind: 'override' }]);

    const natives = buildSettingsSnapshot(settings, config, seams({
      pickCopilots: () => [
        { path: '/n.db', archive: false, override: false },
        { path: '/m.db', archive: false, override: false },
      ],
    }));
    expect(natives.resolvedCopilotDbs).toEqual([
      { path: '/n.db', kind: 'native' },
      { path: '/m.db', kind: 'native' },
    ]);
  });

  it('lists the scanned locations so "not found" can explain itself', () => {
    const settings = new DesktopSettingsReader(file);
    const snapshot = buildSettingsSnapshot(settings, new Configuration(settings), seams({
      copilotCandidates: () => ['/code/agent-traces.db', '/insiders/agent-traces.db'],
    }));

    expect(snapshot.copilotScannedPaths).toEqual([
      '/code/agent-traces.db',
      '/insiders/agent-traces.db',
    ]);
  });
});

describe('applySettingsPatch', () => {
  it('persists changed values and reports which domains changed', () => {
    const settings = new DesktopSettingsReader(file);
    const changed = applySettingsPatch(settings, {
      claudeEnabled: false,
      sqlitePath: '  /custom/traces.db  ',
    });

    expect(changed).toEqual({ claude: true, copilot: true, deviation: false, deepRetro: false, ai: false });
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
      deepRetroEnabled: false,
      claudeCliPath: '',
      claudeModel: '',
      claudeEffort: '',
    });

    expect(changed).toEqual({ claude: false, copilot: false, deviation: false, deepRetro: false, ai: false });
    // Nothing changed, so nothing was written — first save is what creates the file.
    expect(fs.existsSync(file)).toBe(false);
  });

  it('ignores values of the wrong runtime type', () => {
    const settings = new DesktopSettingsReader(file);
    const changed = applySettingsPatch(settings, {
      claudeEnabled: 'yes' as unknown as boolean,
      sqlitePath: 42 as unknown as string,
      deepRetroEnabled: 'on' as unknown as boolean,
      claudeCliPath: 7 as unknown as string,
    });

    expect(changed).toEqual({ claude: false, copilot: false, deviation: false, deepRetro: false, ai: false });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('persists the deep-retrospective consent only from a real boolean', () => {
    const settings = new DesktopSettingsReader(file);
    const changed = applySettingsPatch(settings, { deepRetroEnabled: true });

    expect(changed).toEqual({ claude: false, copilot: false, deviation: false, deepRetro: true, ai: false });
    const reread = new DesktopSettingsReader(file);
    expect(reread.get('retrospective.deepEnabled', false)).toBe(true);
  });

  it('round-trips the AI keys and reports the ai domain', () => {
    const settings = new DesktopSettingsReader(file);
    const changed = applySettingsPatch(settings, {
      claudeCliPath: '  C:\\tools\\claude.exe  ',
      claudeModel: 'haiku',
      claudeEffort: 'medium',
    });

    expect(changed).toEqual({ claude: false, copilot: false, deviation: false, deepRetro: false, ai: true });
    const reread = new DesktopSettingsReader(file);
    expect(reread.get('aiHelper.claudeCliPath', '')).toBe('C:\\tools\\claude.exe');
    expect(reread.get('aiHelper.claudeModel', '')).toBe('haiku');
    expect(reread.get('aiHelper.claudeEffort', '')).toBe('medium');

    const snapshot = buildSettingsSnapshot(reread, new Configuration(reread), seams());
    expect(snapshot.claudeCliPath).toBe('C:\\tools\\claude.exe');
    expect(snapshot.claudeModel).toBe('haiku');
    expect(snapshot.claudeEffort).toBe('medium');
  });

  it('deletes an AI key when its value is cleared, so the default returns', () => {
    const settings = new DesktopSettingsReader(file);
    settings.update({ 'aiHelper.claudeCliPath': '/custom/claude' });
    const changed = applySettingsPatch(settings, { claudeCliPath: '' });

    expect(changed.ai).toBe(true);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect('aiHelper.claudeCliPath' in raw).toBe(false);
    // The snapshot shows the effective defaults again.
    const snapshot = buildSettingsSnapshot(settings, new Configuration(settings), seams());
    expect(snapshot.claudeCliPath).toBe('');
    expect(snapshot.claudeModel).toBe('sonnet');
    expect(snapshot.claudeEffort).toBe('high');
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

describe('pickCopilotDatabases', () => {
  it('returns every readable native database, not just the first', () => {
    // Two VS Code installs side by side; only reading the first would let a
    // stale stable database hide the Insiders one with the real sessions.
    const relative = path.join('User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db');
    const stable = path.join(dir, 'Code', relative);
    const insiders = path.join(dir, 'Code - Insiders', relative);
    for (const p of [stable, insiders]) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, 'x');
    }

    const settings = new DesktopSettingsReader(file);
    settings.update({ 'copilotArchive.path': path.join(dir, 'missing.db') });
    const picked = pickCopilotDatabases(new Configuration(settings), {
      platform: 'linux',
      env: { XDG_CONFIG_HOME: dir },
      homedir: () => dir,
      statKind: (p) => {
        try {
          return fs.statSync(p).isFile() ? 'file' : 'absent';
        } catch {
          return 'absent';
        }
      },
    });

    expect(picked.map((c) => c.path)).toEqual([stable, insiders]);
    expect(picked.every((c) => !c.archive && !c.override)).toBe(true);
  });
});
