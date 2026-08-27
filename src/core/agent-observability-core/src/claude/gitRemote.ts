import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sanitizeRepositoryUrl, UNKNOWN_REPOSITORY } from '../telemetry/repositoryUrl';

/**
 * Resolve the SANITIZED repository for a Claude Code session from the `cwd` its
 * transcript records carry.
 *
 * Claude transcripts record `cwd` + `gitBranch` but NOT the git remote URL, so we
 * derive the remote by walking up from `cwd` to the enclosing `.git` and reading
 * its `[remote "origin"]` url — then run it through the SAME
 * {@link sanitizeRepositoryUrl} chokepoint the Copilot path uses, so a Claude
 * session for a repo groups under the identical canonical
 * `https://{host}/{owner}/{repo}` node as Copilot, and any credential-bearing
 * remote is stripped before it can reach a view or an aggregate.
 *
 * The raw config-text parsing is pure ({@link parseGitConfigRemote}) and tested;
 * the filesystem walk is cached per `cwd` for the life of the resolver instance.
 *
 * An SCP/ssh remote may use an SSH HOST ALIAS (`git@github-work:owner/repo`,
 * with `Host github-work / HostName github.com` in `~/.ssh/config`) — common
 * for a second account on the same forge. The sanitizer rejects such dotless
 * hosts, so without resolution every alias-remoted repo collapsed to `unknown`.
 * The alias is substituted from the ssh config BEFORE sanitizing; a repo under
 * `\\wsl$\<distro>\home\<user>\...` consults that WSL user's ssh config first.
 */

/** Resolves `cwd` → sanitized repository, caching results per directory. */
export class GitRemoteResolver {
  private readonly cache = new Map<string, string>();
  /** Parsed `Host alias → HostName` maps per ssh-config path (undefined = unreadable). */
  private readonly sshConfigCache = new Map<string, ReadonlyMap<string, string> | undefined>();

  /** Inject a reader / home dir for tests; defaults to the real filesystem. */
  constructor(
    private readonly io: GitRemoteIo = defaultGitRemoteIo,
    private readonly homeDir: string = os.homedir(),
  ) {}

  /** Sanitized repository for a working directory, or `unknown`. Cached. */
  resolve(cwd: string | undefined | null): string {
    if (cwd === undefined || cwd === null || cwd.length === 0) {
      return UNKNOWN_REPOSITORY;
    }
    const cached = this.cache.get(cwd);
    if (cached !== undefined) {
      return cached;
    }
    const repository = this.resolveUncached(cwd);
    this.cache.set(cwd, repository);
    return repository;
  }

  private resolveUncached(cwd: string): string {
    const configPath = this.findGitConfig(cwd);
    if (configPath === undefined) {
      return UNKNOWN_REPOSITORY;
    }
    const text = this.io.readFile(configPath);
    if (text === undefined) {
      return UNKNOWN_REPOSITORY;
    }
    const raw = parseGitConfigRemote(text);
    return sanitizeRepositoryUrl(this.resolveSshHostAlias(raw, cwd));
  }

  /**
   * Substitute a dotless SSH host alias in `raw` with its `HostName` from the
   * relevant ssh config(s). A remote whose host already looks real (contains a
   * dot) and any unresolvable alias pass through unchanged.
   */
  private resolveSshHostAlias(raw: string | undefined, cwd: string): string | undefined {
    if (raw === undefined) {
      return undefined;
    }
    // ssh://[user@]host[:port]/path — handled before the SCP form so the
    // scheme's own colon is never mistaken for the SCP separator.
    const sshUrl = /^ssh:\/\/([^/@]+@)?([^/:]+)((?::\d+)?\/.+)$/.exec(raw);
    if (sshUrl !== null) {
      const real = this.sshHostName(sshUrl[2], cwd);
      return real === undefined ? raw : `ssh://${sshUrl[1] ?? ''}${real}${sshUrl[3]}`;
    }
    if (raw.includes('://')) {
      return raw; // http(s)/git scheme: host aliases don't apply
    }
    // SCP-style: [user@]host:path.
    const scp = /^([^/@]+@)?([^/:]+):(.+)$/.exec(raw);
    if (scp === null) {
      return raw;
    }
    const real = this.sshHostName(scp[2], cwd);
    return real === undefined ? raw : `${scp[1] ?? ''}${real}:${scp[3]}`;
  }

  /** `HostName` for a dotless alias from the candidate ssh configs, else undefined. */
  private sshHostName(host: string, cwd: string): string | undefined {
    if (host.length <= 1 || host.includes('.')) {
      return undefined; // a real host (or a Windows drive letter) — not an alias
    }
    for (const configPath of this.sshConfigCandidates(cwd)) {
      const real = this.sshAliases(configPath)?.get(host);
      if (real !== undefined) {
        return real;
      }
    }
    return undefined;
  }

  private sshAliases(configPath: string): ReadonlyMap<string, string> | undefined {
    if (this.sshConfigCache.has(configPath)) {
      return this.sshConfigCache.get(configPath);
    }
    const text = this.io.readFile(configPath);
    const parsed = text === undefined ? undefined : parseSshConfigHostNames(text);
    this.sshConfigCache.set(configPath, parsed);
    return parsed;
  }

  /**
   * The ssh configs that could define `cwd`'s aliases: for a repo reached over
   * `\\wsl$` (or `\\wsl.localhost`), that WSL user's config first — the remote
   * was configured inside WSL — then the local home's config.
   */
  private sshConfigCandidates(cwd: string): string[] {
    const candidates: string[] = [];
    const wsl = /^[\\/]{2}(wsl\$|wsl\.localhost)[\\/]([^\\/]+)[\\/]home[\\/]([^\\/]+)[\\/]/i.exec(cwd);
    if (wsl !== null) {
      candidates.push(`\\\\${wsl[1]}\\${wsl[2]}\\home\\${wsl[3]}\\.ssh\\config`);
    }
    if (this.homeDir.length > 0) {
      candidates.push(path.join(this.homeDir, '.ssh', 'config'));
    }
    return candidates;
  }

  /**
   * Walk up from `cwd` to the first `.git`, returning the path to the config that
   * holds the remotes. Handles a normal repo (`.git/` directory), and a linked
   * worktree / submodule (`.git` FILE with a `gitdir:` pointer, whose remotes
   * live in the shared common dir resolved via `commondir`).
   */
  private findGitConfig(cwd: string): string | undefined {
    let dir = path.normalize(cwd);
    // Bound the walk so a pathological path can't loop forever.
    for (let i = 0; i < 64; i += 1) {
      const dotGit = path.join(dir, '.git');
      const kind = this.io.statKind(dotGit);
      if (kind === 'dir') {
        return path.join(dotGit, 'config');
      }
      if (kind === 'file') {
        const resolved = this.resolveGitdirConfig(dotGit);
        if (resolved !== undefined) {
          return resolved;
        }
        return undefined;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        return undefined; // reached filesystem root
      }
      dir = parent;
    }
    return undefined;
  }

  /** Resolve the config path for a `.git` FILE (worktree/submodule pointer). */
  private resolveGitdirConfig(dotGitFile: string): string | undefined {
    const content = this.io.readFile(dotGitFile);
    if (content === undefined) {
      return undefined;
    }
    const match = /^\s*gitdir:\s*(.+?)\s*$/m.exec(content);
    if (match === null) {
      return undefined;
    }
    const baseDir = path.dirname(dotGitFile);
    const gitDir = path.isAbsolute(match[1]) ? match[1] : path.resolve(baseDir, match[1]);
    // A linked worktree's gitdir contains a `commondir` pointing at the shared
    // `.git` whose `config` holds the remotes; fall back to the gitdir itself.
    const commonDirPointer = this.io.readFile(path.join(gitDir, 'commondir'));
    if (commonDirPointer !== undefined) {
      const rel = commonDirPointer.trim();
      const commonDir = path.isAbsolute(rel) ? rel : path.resolve(gitDir, rel);
      return path.join(commonDir, 'config');
    }
    return path.join(gitDir, 'config');
  }
}

/** Filesystem seam for {@link GitRemoteResolver}. */
export interface GitRemoteIo {
  /** `'dir'`, `'file'`, or `'absent'` for a path. */
  statKind(p: string): 'dir' | 'file' | 'absent';
  /** File contents as UTF-8, or `undefined` when unreadable. */
  readFile(p: string): string | undefined;
}

const defaultGitRemoteIo: GitRemoteIo = {
  statKind: (p) => {
    try {
      const stat = fs.statSync(p);
      return stat.isDirectory() ? 'dir' : 'file';
    } catch {
      return 'absent';
    }
  },
  readFile: (p) => {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return undefined;
    }
  },
};

/**
 * Extract the best remote URL from git-config text: the `origin` remote when
 * present, else the first remote in file order. Returns `undefined` when no
 * remote URL is declared.
 *
 * Pure INI-ish parse — tracks the current `[remote "<name>"]` section and reads
 * its `url = ...` value. Section/key matching is case-insensitive on the keyword
 * (`remote`, `url`) per git's config grammar; the remote NAME is case-sensitive.
 */
export function parseGitConfigRemote(text: string): string | undefined {
  const remotes = new Map<string, string>();
  const order: string[] = [];
  let currentRemote: string | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (line.length === 0) {
      continue;
    }
    if (line.startsWith('[')) {
      // Section header. `[remote "origin"]` (with optional inner whitespace) or
      // any other section (which clears the current-remote state).
      const remoteMatch = /^\[\s*remote\s+"([^"]+)"\s*\]$/i.exec(line);
      currentRemote = remoteMatch !== null ? remoteMatch[1] : undefined;
      continue;
    }
    if (currentRemote === undefined) {
      continue;
    }
    const urlMatch = /^url\s*=\s*(.+)$/i.exec(line);
    if (urlMatch !== null) {
      const url = urlMatch[1].trim();
      if (url.length > 0 && !remotes.has(currentRemote)) {
        remotes.set(currentRemote, url);
        order.push(currentRemote);
      }
    }
  }

  if (remotes.size === 0) {
    return undefined;
  }
  return remotes.get('origin') ?? remotes.get(order[0]);
}

/**
 * Extract `Host <alias> → HostName <real>` pairs from ssh-config text. Only
 * literal alias tokens are kept (wildcard/negated patterns configure defaults,
 * not alias identity); per ssh semantics the FIRST HostName obtained for an
 * alias wins. Pure and lenient — an unparseable line is skipped.
 */
export function parseSshConfigHostNames(text: string): Map<string, string> {
  const map = new Map<string, string>();
  let currentAliases: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const match = /^(\S+)(?:\s*=\s*|\s+)(.*)$/.exec(line);
    if (match === null) {
      continue;
    }
    const keyword = match[1].toLowerCase();
    if (keyword === 'host') {
      currentAliases = match[2]
        .split(/\s+/)
        .filter((p) => p.length > 0 && !/[*?]/.test(p) && !p.startsWith('!'));
    } else if (keyword === 'hostname') {
      const value = match[2].trim();
      if (value.length > 0) {
        for (const alias of currentAliases) {
          if (!map.has(alias)) {
            map.set(alias, value);
          }
        }
      }
    }
  }
  return map;
}

/** Drop a trailing `#`/`;` comment that is not inside a quoted value. */
function stripComment(line: string): string {
  let inQuote = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (!inQuote && (ch === '#' || ch === ';')) {
      return line.slice(0, i);
    }
  }
  return line;
}
