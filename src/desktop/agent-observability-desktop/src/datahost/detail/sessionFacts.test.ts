import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Configuration } from '@agent-observability/core/src/config/configuration';
import { LocalDeviationDetector } from '@agent-observability/core/src/deviation/localDeviations';
import type { SessionDataSource } from '@agent-observability/core/src/sources/sessionSource';
import type { SessionDetail } from '@agent-observability/core/src/telemetry/models';
import { emptyActivity } from '@agent-observability/core/src/analysis/sessionActivity';
import { DesktopSettingsReader } from '../drivers/desktopConfig';
import { degradedActivity } from '../analysis/sessionActivity';
import { PACKET_INCLUDE_PROMPTS_KEY, applySettingsPatch, buildSettingsSnapshot } from '../settings';
import { DetailRenderer } from './detailRenderer';

/**
 * `sessionFacts` is the one parse behind the review packet and the hand-off
 * brief: the source is read once per stamp, and the activity once on top.
 */

function detail(): SessionDetail {
  return {
    summary: { sessionId: 's', repository: 'unknown', durationMs: 0, source: 'claude' },
    treeStats: {},
    turns: [
      {
        events: [
          { operation: 'invoke_agent', toolName: 'Explore', success: true },
          { operation: 'execute_tool', toolName: 'Bash', success: true },
          { operation: 'execute_tool', toolName: 'Bash', success: false },
          { operation: 'execute_tool', toolName: 'Edit', success: false },
        ],
      },
    ],
    modelUsage: [],
    agentUsage: [],
    treeModelTurns: [],
  } as unknown as SessionDetail;
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-facts-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function renderer(source: Partial<SessionDataSource>): DetailRenderer {
  const settings = new DesktopSettingsReader(path.join(dir, 'config.json'));
  const config = new Configuration(settings);
  return new DetailRenderer({ get: () => source as SessionDataSource }, new LocalDeviationDetector(config));
}

const context = { acceptedMissing: { files: [], sources: [] }, deepRetro: { enabled: false } };

describe('DetailRenderer.sessionFacts', () => {
  it('parses once per stamp and computes the activity once', () => {
    let details = 0;
    let activities = 0;
    const r = renderer({
      getSessionDetail: () => {
        details += 1;
        return { ok: true, value: detail() };
      },
      getSessionInteractions: () => ({ ok: true, value: [] }),
      getSessionActivity: () => {
        activities += 1;
        return { ok: true, value: emptyActivity(true) };
      },
    });
    const first = r.sessionFacts('claude', 's', 1, context);
    const second = r.sessionFacts('claude', 's', 1, context);
    expect(first.activity).toBe(second.activity);
    expect(first.activity.complete).toBe(true);
    expect(details).toBe(1);
    expect(activities).toBe(1);

    r.sessionFacts('claude', 's', 2, context);
    expect(details).toBe(2);
    expect(activities).toBe(2);
  });

  it('degrades to names and failures for a source without activity', () => {
    const r = renderer({
      getSessionDetail: () => ({ ok: true, value: detail() }),
      getSessionInteractions: () => ({ ok: true, value: [] }),
    });
    const { activity } = r.sessionFacts('copilot', 's', 1, context);
    expect(activity.complete).toBe(false);
    expect(activity.commands).toEqual([]);
    expect(activity.edits).toEqual([]);
    expect(activity.subAgents).toEqual([{ name: 'Explore', calls: 1 }]);
    expect(activity.endedOnFailedTool).toBe(true);
    expect(activity.trailingFailedTools).toBe(2);
  });
});

describe('degradedActivity', () => {
  it('resets the trailing-failure count on a later success', () => {
    const d = detail();
    d.turns[0].events.push({ operation: 'execute_tool', toolName: 'Read', success: true } as never);
    const activity = degradedActivity(d);
    expect(activity.trailingFailedTools).toBe(0);
    expect(activity.endedOnFailedTool).toBe(false);
  });
});

describe('packet.includePrompts setting', () => {
  it('defaults on, round-trips a real boolean and ignores anything else', () => {
    const file = path.join(dir, 'config.json');
    const settings = new DesktopSettingsReader(file);
    const seams = { pickCopilots: () => [], copilotCandidates: () => [], exists: () => false, configPath: file, jetbrainsStores: () => [] };
    const snapshot = (): boolean => buildSettingsSnapshot(settings, new Configuration(settings), seams).packetIncludePrompts;
    expect(snapshot()).toBe(true);
    applySettingsPatch(settings, { packetIncludePrompts: false });
    expect(settings.get(PACKET_INCLUDE_PROMPTS_KEY, true)).toBe(false);
    expect(snapshot()).toBe(false);
    applySettingsPatch(settings, { packetIncludePrompts: 'yes' as unknown as boolean });
    expect(snapshot()).toBe(false);
  });
});
