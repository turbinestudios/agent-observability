import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DesktopSettingsReader } from '../drivers/desktopConfig';
import { TeamController } from './teamController';
import { TEAM_ENABLED_KEY, TEAM_FOLDER_KEY } from './teamExport';
import type { FolderFs } from './teamFolder';

/**
 * The controller's own gate: while Team is off the folder is neither watched
 * nor read, even when one is configured. Everything runs against a temp dir
 * and counting seams; no timer ever fires.
 */
let dir: string;
let folder: string;
let settings: DesktopSettingsReader;
let reads: number;
let timersArmed: number;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-team-controller-'));
  folder = path.join(dir, 'team');
  fs.mkdirSync(folder);
  settings = new DesktopSettingsReader(path.join(dir, 'config.json'));
  reads = 0;
  timersArmed = 0;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function controller(): TeamController {
  const folderFs: FolderFs = {
    statSync: (p) => {
      reads += 1;
      return fs.statSync(p);
    },
    readdirSync: (p) => {
      reads += 1;
      return fs.readdirSync(p);
    },
    readFileSync: (p, encoding) => {
      reads += 1;
      return fs.readFileSync(p, encoding);
    },
  };
  const timers = {
    setTimeout: () => void (timersArmed += 1),
    clearTimeout: () => undefined,
    setInterval: () => void (timersArmed += 1),
    clearInterval: () => undefined,
  };
  return new TeamController({
    db: undefined as never,
    settings,
    sources: undefined as never,
    hidden: undefined as never,
    emit: () => undefined,
    exclusive: async (work) => work(),
    toolVersion: () => '0.0.0',
    now: () => Date.UTC(2026, 9, 1),
    saltPath: path.join(dir, 'salt'),
    statePath: path.join(dir, 'state.json'),
    folderFs,
    watcherTimers: timers,
    schedulerTimers: timers,
  });
}

describe('TeamController', () => {
  it('neither watches nor reads the folder while Team is off', () => {
    settings.update({ [TEAM_FOLDER_KEY]: folder });
    const team = controller();
    team.start();
    const status = team.status();
    expect(status.folder).toBe('');
    expect(status.folderState).toBe('unset');
    expect(status.shareEnabled).toBe(false);
    expect(status.memberCount).toBe(0);
    expect(team.refresh().folderState).toBe('unset');
    expect(reads).toBe(0);
    expect(timersArmed).toBe(0);
    team.dispose();
  });

  it('follows the folder once Team is turned on, and lets go of it when Team is turned off again', () => {
    settings.update({ [TEAM_FOLDER_KEY]: folder });
    const team = controller();
    team.start();

    settings.update({ [TEAM_ENABLED_KEY]: true });
    team.settingsChanged();
    const on = team.status();
    expect(on.folder).toBe(folder);
    expect(on.folderState).not.toBe('unset');
    expect(reads).toBeGreaterThan(0);
    expect(timersArmed).toBeGreaterThan(0);

    settings.update({ [TEAM_ENABLED_KEY]: false });
    team.settingsChanged();
    const before = reads;
    expect(team.status().folderState).toBe('unset');
    expect(reads).toBe(before);
    team.dispose();
  });
});
