import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RunEventChange } from '../../shared/runTypes';
import { RunController } from './runController';
import { resolveRuntimeTarget } from './runtimePath';
import { SdkRunDriver } from './sdkDriver';

/**
 * The one test that talks to the real Copilot CLI. Skipped unless
 * `AO_REAL_COPILOT_RUN=1`, because it uses the signed-in Copilot login and two
 * requests. It proves the structural SDK mapping end to end: a reply arrives,
 * a write asks for permission, a denial is honoured.
 */
const enabled = process.env.AO_REAL_COPILOT_RUN === '1';

async function until(predicate: () => boolean, label: string, timeoutMs = 150_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe.skipIf(!enabled)('Run against the real Copilot CLI', () => {
  it(
    'replies, asks before writing, and honours a denial',
    async () => {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-run-smoke-'));
      const changes: RunEventChange[] = [];
      const driver = new SdkRunDriver({ resolveRuntime: () => resolveRuntimeTarget('') });
      const controller = new RunController({
        driver,
        emit: (_sessionId, change) => changes.push(change),
        enabled: () => true,
        acknowledged: () => true,
        renderMarkdown: (text) => text,
      });
      const statuses = (): string[] => changes.filter((c) => c.type === 'status').map((c) => (c as { status: string }).status);
      let sessionId = '';
      try {
        const availability = await controller.availability();
        expect(availability.cliFound).toBe(true);

        const info = await controller.start({ goal: 'Reply with exactly: ok', repository: 'unknown', cwd: work, door: 'blank' });
        sessionId = info.sessionId;
        await until(() => statuses().includes('idle'), 'the first reply');
        const transcript = controller.transcript(sessionId);
        const assistant = transcript?.items.filter((item) => item.kind === 'assistant') ?? [];
        expect(assistant.length).toBeGreaterThan(0);
        expect(assistant.some((item) => item.kind === 'assistant' && item.html.trim().length > 0)).toBe(true);

        const before = changes.length;
        await controller.send(sessionId, 'Create a file named hello.txt containing hi');
        await until(() => changes.slice(before).some((c) => c.type === 'permission'), 'a permission request');
        const asked = changes.slice(before).find((c) => c.type === 'permission');
        const request = (asked as Extract<RunEventChange, { type: 'permission' }>).request;
        // Report the mapped fields (names only) so a renamed SDK field is visible.
        console.log('permission fields', JSON.stringify({ kind: request.kind, hasFile: request.fileName !== undefined, hasDiffStat: request.diffStat !== undefined, canAllowSession: request.canAllowSession, toolName: request.toolName }));
        expect(request.fileName ?? '').toContain('hello.txt');
        controller.respondPermission(request.requestId, 'deny', 'smoke test: denied');
        await until(() => statuses().slice(-1)[0] === 'idle' && changes.slice(before).some((c) => c.type === 'permission-cleared'), 'idle after the denial');
        expect(fs.existsSync(path.join(work, 'hello.txt'))).toBe(false);
        console.log('usage seen', changes.some((c) => c.type === 'usage'), 'tool items', controller.transcript(sessionId)?.items.filter((i) => i.kind === 'tool').length);
        await controller.close(sessionId);
      } finally {
        await controller.shutdown();
        await driver.dispose();
        // Test cleanup only: remove the smoke session from Copilot history
        // through the CLI's own API. The app itself never deletes there.
        if (sessionId !== '') {
          const target = resolveRuntimeTarget('');
          if ('target' in target) {
            // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
            const sdk = require('@github/copilot-sdk') as {
              CopilotClient: new (options: unknown) => { start(): Promise<void>; deleteSession(id: string): Promise<void>; stop(): Promise<unknown> };
              RuntimeConnection: { forStdio(options: unknown): unknown };
            };
            const client = new sdk.CopilotClient({ connection: sdk.RuntimeConnection.forStdio(target.target), logLevel: 'error' });
            await client.start();
            await client.deleteSession(sessionId).catch(() => undefined);
            await client.stop();
          }
        }
        fs.rmSync(work, { recursive: true, force: true });
      }
    },
    360_000,
  );
});
