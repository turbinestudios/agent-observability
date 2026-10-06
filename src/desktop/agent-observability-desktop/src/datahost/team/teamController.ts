import { computeTeamMetrics, utcDayString } from '@agent-observability/core/src/team/teamMetrics';
import type { TeamMetrics } from '@agent-observability/core/src/team/teamViewModels';
import type {
  RpcEvent,
  TeamExportResult,
  TeamMemberInfo,
  TeamPreview,
  TeamStatus,
  TeamViewData,
  TeamWindow,
} from '../../shared/rpc';
import type { IndexDb } from '../indexer/indexDb';
import type { DesktopSettingsReader } from '../drivers/desktopConfig';
import type { RepoRootSeams } from '../improve/repoRoot';
import { ExportScheduler, type SchedulerTimers } from './exportScheduler';
import {
  exportTeamShard,
  previewTeamShard,
  teamAutoExportOn,
  teamEnabled,
  teamFolder,
  teamSharingOn,
  type TeamExportDeps,
} from './teamExport';
import { TeamFolderWatcher, readTeamFolder, type FolderFs, type TeamFolderRead, type WatcherTimers } from './teamFolder';
import { getOrCreateTeamSalt, getTeamDeveloperId } from './teamSalt';
import type { ShardSourceDeps } from './teamShardSource';
import { TeamStateStore } from './teamState';

/**
 * One object behind the six `team.*` RPCs: the folder watcher, the export
 * scheduler, the last folder read, and the member identity. Exports run
 * through `exclusive` so they never overlap an index pass; folder reads are
 * cheap and run inline.
 */
export interface TeamControllerDeps {
  db: IndexDb;
  settings: DesktopSettingsReader;
  sources: ShardSourceDeps['sources'];
  hidden: ShardSourceDeps['hidden'];
  emit: (event: RpcEvent) => void;
  /** Serialize a write behind the background controller. */
  exclusive: <T>(work: () => T) => Promise<T>;
  toolVersion: () => string;
  // ── seams ──
  now?: () => number;
  saltPath?: string;
  statePath?: string;
  folderFs?: FolderFs;
  watcherTimers?: WatcherTimers;
  schedulerTimers?: SchedulerTimers;
  repoRootSeams?: RepoRootSeams;
  exportFs?: TeamExportDeps['fs'];
}

export class TeamController {
  private readonly state: TeamStateStore;
  private readonly watcher: TeamFolderWatcher;
  private readonly scheduler: ExportScheduler;
  private readonly now: () => number;
  private salt: string | undefined;
  private lastRead: TeamFolderRead | undefined;
  private lastReadAtMs: number | undefined;
  private exporting = false;

  constructor(private readonly deps: TeamControllerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.state = new TeamStateStore(deps.statePath);
    this.watcher = new TeamFolderWatcher({
      folder: () => this.folder(),
      onChange: () => {
        this.read();
        this.deps.emit({ event: 'team.changed', status: this.status() });
      },
      ...(deps.folderFs !== undefined ? { io: deps.folderFs } : {}),
      ...(deps.watcherTimers !== undefined ? { timers: deps.watcherTimers } : {}),
    });
    this.scheduler = new ExportScheduler({
      enabled: () => teamSharingOn(deps.settings) && teamAutoExportOn(deps.settings) && teamFolder(deps.settings).length > 0,
      run: () => void this.exportNow(),
      ...(deps.schedulerTimers !== undefined ? { timers: deps.schedulerTimers } : {}),
    });
  }

  /** Arm the watcher and scheduler for the current settings. */
  start(): void {
    this.watcher.start();
    this.scheduler.arm();
  }

  /** The team settings changed: follow them. */
  settingsChanged(): void {
    this.lastRead = undefined;
    this.watcher.start();
    this.scheduler.arm();
    this.deps.emit({ event: 'team.changed', status: this.status() });
  }

  dispose(): void {
    this.watcher.stop();
    this.scheduler.disarm();
  }

  developerId(): string {
    if (this.salt === undefined) {
      this.salt = getOrCreateTeamSalt(this.deps.saltPath);
    }
    return getTeamDeveloperId(this.salt);
  }

  status(): TeamStatus {
    const folder = this.folder();
    const read = folder.length === 0 ? undefined : this.ensureRead();
    const state = this.state.get();
    return {
      folder,
      folderState: folder.length === 0 ? 'unset' : (read?.folderState ?? 'missing'),
      watchMode: this.watcher.watchMode(),
      shareEnabled: teamSharingOn(this.deps.settings),
      autoExport: teamAutoExportOn(this.deps.settings),
      developerId: this.developerId(),
      ...(state.lastExportAtMs !== undefined ? { lastExportAtMs: state.lastExportAtMs } : {}),
      ...(state.lastExportBytes !== undefined ? { lastExportBytes: state.lastExportBytes } : {}),
      ...(state.lastExportError !== undefined ? { lastExportError: state.lastExportError } : {}),
      exporting: this.exporting,
      memberCount: read?.merged.members.size ?? 0,
      problems: read?.problems.map((p) => ({ fileName: p.fileName, reason: p.reason, ...(p.detail !== undefined ? { detail: p.detail } : {}) })) ?? [],
      ...(this.lastReadAtMs !== undefined ? { lastReadAtMs: this.lastReadAtMs } : {}),
    };
  }

  refresh(): TeamStatus {
    this.read();
    const status = this.status();
    this.deps.emit({ event: 'team.changed', status });
    return status;
  }

  preview(): TeamPreview {
    return previewTeamShard(this.exportDeps());
  }

  async exportNow(): Promise<TeamExportResult> {
    if (this.exporting) {
      return { ok: false, error: 'An export is already running.' };
    }
    this.exporting = true;
    this.deps.emit({ event: 'team.changed', status: this.status() });
    try {
      const result = await this.deps.exclusive(() => exportTeamShard(this.exportDeps()));
      // Our own file changed: re-read so the view counts us immediately.
      this.read();
      return result;
    } finally {
      this.exporting = false;
      this.deps.emit({ event: 'team.changed', status: this.status() });
    }
  }

  view(window: TeamWindow): TeamViewData {
    const read = this.ensureRead();
    const now = this.now();
    const metrics: TeamMetrics = computeTeamMetrics({
      merged: read.merged,
      window,
      myId: this.developerId(),
      todayUtc: utcDayString(now),
      nowMs: now,
    });
    return { ...metrics, status: this.status() };
  }

  members(): TeamMemberInfo[] {
    return this.view(30).members;
  }

  // ── internals ──

  private ensureRead(): TeamFolderRead {
    if (this.lastRead === undefined) {
      this.read();
    }
    return this.lastRead as TeamFolderRead;
  }

  /** The folder this controller may watch and read: none while Team is off. */
  private folder(): string {
    return teamEnabled(this.deps.settings) ? teamFolder(this.deps.settings) : '';
  }

  private read(): void {
    const folder = this.folder();
    this.lastRead =
      folder.length === 0
        ? { merged: { members: new Map(), problems: [] }, files: [], problems: [], folderState: 'missing' }
        : readTeamFolder(folder, this.deps.folderFs);
    this.lastReadAtMs = this.now();
  }

  private exportDeps(): TeamExportDeps {
    return {
      db: this.deps.db,
      settings: this.deps.settings,
      sources: this.deps.sources,
      hidden: this.deps.hidden,
      state: this.state,
      developerId: () => this.developerId(),
      toolVersion: this.deps.toolVersion,
      now: this.now,
      ...(this.deps.repoRootSeams !== undefined ? { repoRootSeams: this.deps.repoRootSeams } : {}),
      ...(this.deps.exportFs !== undefined ? { fs: this.deps.exportFs } : {}),
    };
  }
}
