import { describe, it, expect } from 'vitest';
import {
  GlobalWorkspaceReposIo,
  buildGlobalSessionRepositories,
  workspaceFolderLocalPath,
} from './globalWorkspaceRepos';

/** Separator-agnostic compare (path.normalize emits `\` on win32, `/` elsewhere). */
const norm = (p: string | undefined): string | undefined => p?.replace(/\\/g, '/');

describe('workspaceFolderLocalPath', () => {
  it('decodes a Windows file: folder URI to a drive path', () => {
    expect(norm(workspaceFolderLocalPath('file:///c%3A/Projects/example-org/app'))).toBe(
      'c:/Projects/example-org/app',
    );
  });

  it('keeps the leading slash for a POSIX file: folder URI', () => {
    expect(norm(workspaceFolderLocalPath('file:///home/dev/proj'))).toBe('/home/dev/proj');
  });

  it('maps a WSL remote folder to its \\\\wsl$ UNC path', () => {
    expect(
      workspaceFolderLocalPath('vscode-remote://wsl%2Bubuntu/home/dev/projects/x'),
    ).toBe('\\\\wsl$\\ubuntu\\home\\dev\\projects\\x');
  });

  it('returns undefined for unreachable remotes and malformed URIs', () => {
    expect(workspaceFolderLocalPath('vscode-remote://ssh-remote%2Bmyhost/home/u')).toBeUndefined();
    expect(workspaceFolderLocalPath('vscode-remote://dev-container%2Babc/ws')).toBeUndefined();
    expect(workspaceFolderLocalPath('untitled:Untitled-1')).toBeUndefined();
    expect(workspaceFolderLocalPath('file:///%zz-bad-encoding')).toBeUndefined();
  });
});

const UUID_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const UUID_B = 'bbbbbbbb-1111-2222-3333-444444444444';
const UUID_D = 'dddddddd-1111-2222-3333-444444444444';
const REPO_A = 'https://github.com/org/alpha';
const REPO_B = 'https://github.com/org/beta';

describe('buildGlobalSessionRepositories', () => {
  it('maps every workspace store session id to its folder repo, skipping the unusable', () => {
    const files: Record<string, string> = {
      'hashA/workspace.json': '{"folder":"file:///c%3A/proj/alpha"}',
      'hashB/workspace.json': '{"folder":"vscode-remote://wsl%2Bubuntu/home/dev/beta"}',
      // hashC has no workspace.json at all.
      'hashD/workspace.json': '{"folder":"file:///c%3A/proj/norepo"}',
      'hashE/workspace.json': 'not json',
      'hashF/workspace.json': '{"folder":"file:///c%3A/proj/empty"}',
    };
    const sessions: Record<string, string[]> = {
      hashA: [`${UUID_A.toUpperCase()}.jsonl`, 'junk.txt'],
      hashB: [`${UUID_B}.jsonl`],
      hashD: [`${UUID_D}.jsonl`],
      hashF: [],
    };
    const io: GlobalWorkspaceReposIo = {
      listDirectories: (root) =>
        norm(root) === '/store' ? ['hashA', 'hashB', 'hashC', 'hashD', 'hashE', 'hashF'] : [],
      readFile: (p) => {
        const n = norm(p) ?? '';
        for (const [suffix, content] of Object.entries(files)) {
          if (n.endsWith(`/${suffix}`)) {
            return content;
          }
        }
        return undefined;
      },
      listChatSessionFiles: (dir) => {
        const n = norm(dir) ?? '';
        for (const [hash, names] of Object.entries(sessions)) {
          if (n.endsWith(`/${hash}/chatSessions`)) {
            return names;
          }
        }
        return [];
      },
      statMtimeMs: () => undefined,
    };

    const resolved: string[] = [];
    const resolveRepository = (localPath: string): string => {
      resolved.push(localPath);
      const n = norm(localPath) ?? '';
      if (n.includes('alpha')) {
        return REPO_A;
      }
      if (n.includes('beta')) {
        return REPO_B;
      }
      return 'unknown';
    };

    const map = buildGlobalSessionRepositories('/store', resolveRepository, io);

    // Ids are lowercased; the WSL folder resolves over its UNC path; a folder
    // with no git remote contributes nothing.
    expect(map.get(UUID_A)).toBe(REPO_A);
    expect(map.get(UUID_B)).toBe(REPO_B);
    expect(map.has(UUID_D)).toBe(false);
    expect(map.size).toBe(2);
    // The session-less store (hashF) never pays for a git walk.
    expect(resolved.some((p) => (norm(p) ?? '').includes('empty'))).toBe(false);
    expect(resolved.some((p) => p.startsWith('\\\\wsl$\\'))).toBe(true);
  });

  it('returns an empty map when the storage root is unreadable', () => {
    const io: GlobalWorkspaceReposIo = {
      listDirectories: () => [],
      readFile: () => undefined,
      listChatSessionFiles: () => [],
      statMtimeMs: () => undefined,
    };
    expect(buildGlobalSessionRepositories('/nope', () => 'unknown', io).size).toBe(0);
  });
});
