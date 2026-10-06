import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultCopilotCliFs } from '../copilotCli/paths';
import { CopilotJetbrainsSource } from './copilotJetbrainsSource';
import { resolveJetbrainsRepository } from './mapper';
import { decodeModifiedUtf8, extractJavaStrings, scanNitriteStore } from './nitriteScan';
import { copilotJetbrainsRoot, discoverJetbrainsStores, jetbrainsIdeName, type JetbrainsFs } from './paths';

/**
 * Copilot in JetBrains IDEs. No IDE was available to record a real store,
 * so the stores here are built byte by byte in the shape codeburn documents
 * (docs/providers/copilot.md): Java-serialized strings and class names
 * inside an MVStore file. They pin what the scanner reads, not that the
 * plugin really writes it; the probe script is what checks a real machine.
 */
const T0 = Date.UTC(2026, 8, 1, 9, 0, 0);
const NOW = T0 + 30 * 86_400_000;

const GUID_A = '0f8fad5b-d9cb-469f-a165-70867728950e';
const GUID_B = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

/** Bytes as Java's ObjectOutputStream writes them. */
const b = {
  header: (): Buffer => Buffer.from('H:2,block:9,format:3,', 'latin1'),
  str: (value: string): Buffer => {
    const bytes = Buffer.from(value, 'utf8');
    const head = Buffer.alloc(3);
    head[0] = 0x74;
    head.writeUInt16BE(bytes.length, 1);
    return Buffer.concat([head, bytes]);
  },
  cls: (name: string): Buffer => {
    const bytes = Buffer.from(name, 'latin1');
    const head = Buffer.alloc(3);
    head[0] = 0x72;
    head.writeUInt16BE(bytes.length, 1);
    // serialVersionUID and flags follow a class name; any bytes do here.
    return Buffer.concat([head, bytes, Buffer.from([0, 0, 0, 0, 0, 0, 0, 1, 2, 0, 0])]);
  },
  long: (ms: number): Buffer => {
    const out = Buffer.alloc(9);
    out[0] = 0x77; // TC_BLOCKDATA-ish filler before the field value
    out.writeBigUInt64BE(BigInt(ms), 1);
    return out;
  },
  pad: (n = 4): Buffer => Buffer.alloc(n, 0x70),
};

const pkg = 'com.github.copilot.chat.session.persistence';

function agentTurn(prompt: string, reply: string, ms: number, model?: string): Buffer[] {
  return [
    b.cls(`${pkg}.NtAgentTurn`),
    b.long(ms),
    b.cls(`${pkg}.Markdown`),
    b.str('text'),
    b.str(prompt),
    b.pad(),
    b.cls(`${pkg}.Thinking`),
    b.str('text'),
    b.str('private chain of thought'),
    b.cls(`${pkg}.AgentRound`),
    b.str('reply'),
    b.str(reply),
    ...(model !== undefined ? [b.str('model'), b.str(model)] : []),
    b.pad(),
  ];
}

function sampleStore(): Buffer {
  return Buffer.concat([
    b.header(),
    b.pad(64),
    b.cls(`${pkg}.NtAgentSession`),
    b.str(GUID_A),
    b.str('title'),
    b.str('New chat'),
    b.str('projectName'),
    b.str('o/widgets'),
    ...agentTurn('Why does login fail?', 'The token expires early.', T0, 'claude-sonnet-4.5'),
    ...agentTurn('Fix it', 'Done: refreshed the token before expiry.', T0 + 60_000),
    // A superseded page still holding a half-written copy of the last turn.
    ...agentTurn('Fix it', 'Done: refreshed', T0 + 60_000),
    b.cls(`${pkg}.NtAgentSession`),
    b.str(GUID_A),
    b.str('title'),
    b.str('Login token expiry'),
    b.cls(`${pkg}.NtAgentSession`),
    b.str(GUID_B),
    b.str('title'),
    b.str('Ask about generics'),
    b.cls(`${pkg}.NtAgentTurn`),
    b.long(T0 + 3_600_000),
    b.cls(`${pkg}.Markdown`),
    b.str('text'),
    b.str('What is a covariant interface?'),
    b.cls(`${pkg}.Markdown`),
    b.str('text'),
    b.str('One whose type parameter is marked out.'),
    b.str('model'),
    b.str('gpt-5'),
    b.pad(32),
  ]);
}

describe('reading Java strings', () => {
  it('decodes modified UTF-8, including supplementary characters as surrogate pairs', () => {
    expect(decodeModifiedUtf8(Buffer.from('héllo', 'utf8'))).toBe('héllo');
    // U+1F600 as Java writes it: two 3-byte surrogates.
    expect(decodeModifiedUtf8(Buffer.from([0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80]))).toBe('\u{1F600}');
    expect(decodeModifiedUtf8(Buffer.from([0xc3]))).toBeUndefined();
  });

  it('finds string values and class names, and skips bytes that only look like a tag', () => {
    const buf = Buffer.concat([Buffer.from([0x74, 0x00, 0x05, 0x01, 0x02]), b.str('text'), b.cls('a.b.Markdown')]);
    expect(extractJavaStrings(buf).map((s) => [s.kind, s.value])).toEqual([
      ['string', 'text'],
      ['class', 'a.b.Markdown'],
    ]);
  });
});

describe('scanning a chat store', () => {
  it('reads conversations, their latest titles, turns, models and times', () => {
    const scan = scanNitriteStore(sampleStore(), NOW);
    expect(scan.stats.mvstoreHeader).toBe(true);
    expect(scan.conversations.map((c) => [c.id, c.title, c.turns.length])).toEqual([
      [GUID_A, 'Login token expiry', 2],
      [GUID_B, 'Ask about generics', 1],
    ]);
    const [login, ask] = scan.conversations;
    expect(login.projectName).toBe('o/widgets');
    expect(login.turns[0]).toEqual({
      mode: 'agent',
      prompt: 'Why does login fail?',
      reply: 'The token expires early.',
      model: 'claude-sonnet-4.5',
      timestampMs: T0,
    });
    // The half-written copy was folded into the full reply.
    expect(login.turns[1]).toMatchObject({ prompt: 'Fix it', reply: 'Done: refreshed the token before expiry.', timestampMs: T0 + 60_000 });
    expect(ask.turns).toEqual([
      { mode: 'ask', prompt: 'What is a covariant interface?', reply: 'One whose type parameter is marked out.', model: 'gpt-5', timestampMs: T0 + 3_600_000 },
    ]);
  });

  it('never reads a side record as a turn', () => {
    const text = JSON.stringify(scanNitriteStore(sampleStore(), NOW).conversations);
    expect(text).not.toContain('private chain of thought');
  });

  it('reads the legacy single-document layout as one conversation without an id', () => {
    const buf = Buffer.concat([
      b.header(),
      b.cls(`${pkg}.Markdown`),
      b.str('text'),
      b.str('Old question'),
      b.cls(`${pkg}.AgentRound`),
      b.str('reply'),
      b.str('Old answer'),
    ]);
    const scan = scanNitriteStore(buf, NOW);
    expect(scan.conversations).toHaveLength(1);
    expect(scan.conversations[0].id).toBeUndefined();
    expect(scan.conversations[0].turns[0]).toMatchObject({ prompt: 'Old question', reply: 'Old answer', mode: 'agent' });
  });

  it('yields nothing, without throwing, for bytes it does not recognise', () => {
    let seed = 7;
    const noise = Buffer.alloc(200_000);
    for (let i = 0; i < noise.length; i += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      noise[i] = seed & 0xff;
    }
    const scan = scanNitriteStore(noise, NOW);
    expect(scan.conversations).toEqual([]);
    expect(scan.stats.mvstoreHeader).toBe(false);
    expect(scanNitriteStore(Buffer.alloc(0), NOW).conversations).toEqual([]);
  });
});

describe('where the stores are', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-jetbrains-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const fakeEnv = (platform: NodeJS.Platform, env: Record<string, string> = {}): JetbrainsFs => ({
    ...defaultCopilotCliFs,
    homedir: () => path.join(root, 'home'),
    env,
    platform,
  });

  it('defaults per platform and honours an override', () => {
    expect(copilotJetbrainsRoot(undefined, fakeEnv('win32', { LOCALAPPDATA: path.join(root, 'Local') }))).toBe(
      path.join(root, 'Local', 'github-copilot'),
    );
    expect(copilotJetbrainsRoot(undefined, fakeEnv('darwin'))).toBe(path.join(root, 'home', '.config', 'github-copilot'));
    expect(copilotJetbrainsRoot(undefined, fakeEnv('linux', { XDG_CONFIG_HOME: path.join(root, 'xdg') }))).toBe(
      path.join(root, 'xdg', 'github-copilot'),
    );
    expect(copilotJetbrainsRoot(path.join(root, 'custom'), fakeEnv('win32'))).toBe(path.join(root, 'custom'));
  });

  it('finds chat stores only, leaving Visual Studio files and background snapshots alone', () => {
    const base = path.join(root, 'github-copilot');
    const write = (rel: string): void => {
      const file = path.join(base, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'H:2,');
    };
    write(path.join('Rider2026.2', 'chat-agent-sessions', 'abc', 'copilot-agent-sessions-nitrite.db'));
    write(path.join('iu', 'chat-sessions', 'copilot-chat-nitrite.db'));
    write(path.join('Rider2026.2', 'bg-agent-sessions', 'abc', 'copilot-agent-snapshots.db'));
    write('auth.db');
    write(path.join('multiLanguageContextProviderDocumentSymbols', 'x.db'));
    const stores = discoverJetbrainsStores(base, fakeEnv('win32'));
    expect(stores.map((s) => [s.ide, s.kind, path.basename(s.path)]).sort()).toEqual([
      ['Rider2026.2', 'chat-agent-sessions', 'copilot-agent-sessions-nitrite.db'],
      ['iu', 'chat-sessions', 'copilot-chat-nitrite.db'],
    ]);
  });

  it('names IDEs from product codes and versioned folders', () => {
    expect(jetbrainsIdeName('Rider2026.2')).toBe('Rider');
    expect(jetbrainsIdeName('rd')).toBe('Rider');
    expect(jetbrainsIdeName('iu')).toBe('IntelliJ IDEA');
    expect(jetbrainsIdeName('PyCharm2025.2')).toBe('PyCharm');
    expect(jetbrainsIdeName('Fleet')).toBe('Fleet');
  });

  it('lists sessions from a store with no tokens and no cost', () => {
    const base = path.join(root, 'github-copilot');
    const file = path.join(base, 'Rider2026.2', 'chat-agent-sessions', 'abc', 'copilot-agent-sessions-nitrite.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, sampleStore());
    const source = new CopilotJetbrainsSource(
      {
        isCopilotJetbrainsEnabled: () => true,
        getCopilotJetbrainsStorePath: () => base,
        getExcludedRepositories: () => new Set(),
      },
      fakeEnv('win32'),
      undefined,
      () => NOW,
    );
    const listed = source.listSessions();
    expect(listed.ok).toBe(true);
    if (!listed.ok) {
      return;
    }
    expect(listed.value.map((s) => [s.sessionId, s.title, s.repository, s.source])).toEqual([
      [GUID_A, 'Login token expiry', 'https://github.com/o/widgets', 'copilot-jetbrains'],
      [GUID_B, 'Ask about generics', 'unknown', 'copilot-jetbrains'],
    ]);
    const first = listed.value[0];
    expect(first).toMatchObject({ llmCalls: 2, inputTokens: 0, outputTokens: 0, startedAtMs: T0, endedAtMs: T0 + 60_000 });
    expect(first.costMicros).toBeUndefined();
    const detail = source.getSessionDetail(GUID_B);
    expect(detail.ok && detail.value.turns[0]).toMatchObject({ agentMode: 'ask', userRequest: 'What is a covariant interface?' });
  });

  it('reports a store it cannot read instead of failing', () => {
    const base = path.join(root, 'github-copilot');
    const file = path.join(base, 'Rider2026.2', 'chat-sessions', 'copilot-chat-nitrite.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'H:2,');
    const source = new CopilotJetbrainsSource(
      { isCopilotJetbrainsEnabled: () => true, getCopilotJetbrainsStorePath: () => base, getExcludedRepositories: () => new Set() },
      fakeEnv('win32'),
      () => {
        throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      },
    );
    const [store] = source.stores();
    expect(source.load(store).problem).toBe('locked');
    expect(source.listSessions()).toEqual({ ok: true, value: [] });
  });

  it('finds the repository from a referenced file when the project name is no remote', () => {
    const repo = path.join(root, 'checkout');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    const uri = pathToFileURL(path.join(repo, 'src', 'a.cs')).href;
    const resolved = resolveJetbrainsRepository(
      { projectName: 'checkout', fileUris: [uri], turns: [] },
      (dir) => (dir === path.join(repo, 'src') ? 'https://github.com/o/checkout' : 'unknown'),
    );
    expect(resolved).toBe('https://github.com/o/checkout');
  });
});
