import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CopilotContextHotspotsProvider, type HotspotTelemetry } from './contextHotspotsProvider';
import type { Result } from '../telemetry/telemetryService';
import type { SessionSummary } from '../telemetry/models';

const REPO = 'https://github.com/acme/widgets';
const ok = <T>(value: T): Result<T> => ({ ok: true, value });

function summary(sessionId: string, title: string): SessionSummary {
  return {
    sessionId,
    repository: REPO,
    startedAtMs: Date.parse('2026-06-01T10:00:00.000Z'),
    endedAtMs: Date.parse('2026-06-01T10:05:00.000Z'),
    durationMs: 300_000,
    interactionCount: 3,
    llmCalls: 2,
    toolCalls: 1,
    inputTokens: 100,
    outputTokens: 50,
    cachedTokens: 0,
    model: 'gpt-4o',
    agentModes: ['agent'],
    title,
  };
}

describe('CopilotContextHotspotsProvider', () => {
  let tmpDir: string;
  let secAbs: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'agent-obs-hotspot-'));
    secAbs = path.join(tmpDir, '.github/instructions/security.instructions.md');
    mkdirSync(path.dirname(secAbs), { recursive: true });
    writeFileSync(secAbs, '# security\n'.repeat(40), 'utf8');
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** A telemetry fake: s1 lists the file in its system prompt; s2 reads it. */
  function makeTelemetry(): { telemetry: HotspotTelemetry; listCalls: () => number } {
    let calls = 0;
    const telemetry: HotspotTelemetry = {
      listSessions: () => {
        calls += 1;
        return ok([summary('s1', 'Harden auth'), summary('s2', 'Fix bug')]);
      },
      getContextDiscoveryEvents: () => ok([]),
      getContextToolReads: (key) => ok(key === 's2' ? [{ filePath: secAbs }] : []),
      getSystemInstructionsBySpan: (key) =>
        ok(key === 's1' ? new Map([['span1', { value: `<file>${secAbs}</file>` }]]) : new Map()),
    };
    return { telemetry, listCalls: () => calls };
  }

  it('builds one hotspot from fused system-prompt + tool-read signals, retaining session ids', () => {
    const { telemetry } = makeTelemetry();
    const provider = new CopilotContextHotspotsProvider(telemetry, () => tmpDir, () => true);

    const result = provider.getHotspots();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value).toHaveLength(1);
    const [hotspot] = result.value;
    expect(hotspot.contextFile).toBe('.github/instructions/security.instructions.md');
    expect(hotspot.category).toBe('instruction');
    expect(hotspot.sessions.map((s) => s.sessionKey).sort()).toEqual(['s1', 's2']);
  });

  it('resolves session display metadata via describeSession', () => {
    const { telemetry } = makeTelemetry();
    const provider = new CopilotContextHotspotsProvider(telemetry, () => tmpDir, () => true);
    provider.getHotspots();

    expect(provider.describeSession('s1')?.title).toBe('Harden auth');
    expect(provider.describeSession('unknown')).toBeUndefined();
  });

  it('caches the built index until refresh()', () => {
    const { telemetry, listCalls } = makeTelemetry();
    const provider = new CopilotContextHotspotsProvider(telemetry, () => tmpDir, () => true);

    provider.getHotspots();
    provider.getHotspots();
    expect(listCalls()).toBe(1); // second call served from cache

    provider.refresh();
    provider.getHotspots();
    expect(listCalls()).toBe(2); // rebuilt after refresh
  });

  it('propagates a telemetry failure as an error result', () => {
    const telemetry: HotspotTelemetry = {
      listSessions: () => ({ ok: false, reason: 'missingDb', message: 'no db' }),
      getContextDiscoveryEvents: () => ok([]),
      getContextToolReads: () => ok([]),
      getSystemInstructionsBySpan: () => ok(new Map()),
    };
    const provider = new CopilotContextHotspotsProvider(telemetry, () => tmpDir, () => true);

    const result = provider.getHotspots();
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe('missingDb');
    expect(provider.describeSession('s1')).toBeUndefined();
  });

  it('reflects the injected enablement flag via isEnabled()', () => {
    let enabled = false;
    const { telemetry } = makeTelemetry();
    const provider = new CopilotContextHotspotsProvider(telemetry, () => tmpDir, () => enabled);

    expect(provider.isEnabled()).toBe(false);
    enabled = true;
    expect(provider.isEnabled()).toBe(true);
  });
});
