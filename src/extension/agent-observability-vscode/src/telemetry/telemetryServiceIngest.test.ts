import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TelemetryService, ServiceConfig } from './telemetryService';
import { PathEnvironment } from './paths';
import { IngestStore } from '../otel/ingestStore';
import { flattenSpans } from '../otel/otlpParse';
import { otlpSpansToRows } from '../otel/otlpToRows';

const sv = (s: string) => ({ stringValue: s });
const iv = (n: number) => ({ intValue: String(n) });
const SESSION = 'ingest-sess';

const envelope = {
  resourceSpans: [
    {
      resource: { attributes: [] },
      scopeSpans: [
        {
          spans: [
            {
              name: 'chat',
              spanId: 'c1',
              traceId: 't1',
              startTimeUnixNano: '1700000000000000000',
              endTimeUnixNano: '1700000001000000000',
              status: { code: 1 },
              attributes: [
                { key: 'gen_ai.operation.name', value: sv('chat') },
                { key: 'gen_ai.agent.name', value: sv('copilot') },
                { key: 'gen_ai.conversation.id', value: sv(SESSION) },
                { key: 'gen_ai.usage.input_tokens', value: iv(42) },
                { key: 'copilot_chat.user_request', value: sv('hi') },
              ],
            },
          ],
        },
      ],
    },
  ],
};

/** A config + environment that find NO Copilot DB, so only the ingest source can apply. */
const config: ServiceConfig = {
  isLocalTelemetryEnabled: () => true,
  getCodeFileExtensions: () => [],
  getDocFileExtensions: () => [],
  getSqlitePathOverride: () => undefined,
};
const noCopilotEnv: PathEnvironment = {
  platform: 'win32',
  env: {},
  homedir: () => '',
  statKind: () => 'absent',
};

let tmp: string | undefined;
afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

describe('TelemetryService with a live-OTLP ingest source', () => {
  it('reads the extension-owned ingest DB as the sole source', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-obs-svc-'));
    const dbPath = path.join(tmp, 'agent-traces.db');
    const store = new IngestStore(dbPath);
    store.writeSpans(otlpSpansToRows(flattenSpans(envelope)));
    store.close();

    const service = new TelemetryService(config, noCopilotEnv);

    // Without an ingest source, no Copilot DB exists → a typed failure (not a throw).
    expect(service.getSessionInteractions(SESSION).ok).toBe(false);

    // Point it at our ingest DB → it becomes the sole source and reads our spans.
    service.setIngestDbPath(dbPath);
    const result = service.getSessionInteractions(SESSION);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0].operation).toBe('chat');
      expect(result.value[0].inputTokens).toBe(42);
    }
    service.dispose();
  });
});

/** A one-chat-span session envelope for the given session id. */
function envelopeFor(session: string) {
  return {
    resourceSpans: [
      {
        resource: { attributes: [] },
        scopeSpans: [
          {
            spans: [
              {
                name: 'chat',
                spanId: `c-${session}`,
                traceId: `tr-${session}`,
                startTimeUnixNano: '1700000000000000000',
                endTimeUnixNano: '1700000001000000000',
                status: { code: 1 },
                attributes: [
                  { key: 'gen_ai.operation.name', value: sv('chat') },
                  { key: 'gen_ai.conversation.id', value: sv(session) },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('TelemetryService with a durable archive source', () => {
  it('reads the archive as the sole source when set and present, else falls back', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-obs-arc-'));
    const archivePath = path.join(tmp, 'agent-traces.db');
    const store = new IngestStore(archivePath);
    store.writeSpans(otlpSpansToRows(flattenSpans(envelopeFor('arch-sess'))));
    store.close();

    const service = new TelemetryService(config, noCopilotEnv);
    // No archive set + no Copilot DB → typed failure.
    expect(service.getSessionInteractions('arch-sess').ok).toBe(false);

    service.setArchiveDbPath(archivePath);
    expect(service.getSessionInteractions('arch-sess').ok).toBe(true);
    service.dispose();
  });

  it('prefers the live-ingest DB over the archive when both are set', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-obs-arc-'));
    const archivePath = path.join(tmp, 'archive.db');
    const ingestPath = path.join(tmp, 'ingest.db');

    const arc = new IngestStore(archivePath);
    arc.writeSpans(otlpSpansToRows(flattenSpans(envelopeFor('arch-only'))));
    arc.close();
    const ing = new IngestStore(ingestPath);
    ing.writeSpans(otlpSpansToRows(flattenSpans(envelopeFor('live-only'))));
    ing.close();

    const service = new TelemetryService(config, noCopilotEnv);
    service.setArchiveDbPath(archivePath);
    service.setIngestDbPath(ingestPath);

    // Live-ingest is the SOLE source → its session has interactions; the
    // archive-only session is invisible (a source is open, so the lookup
    // succeeds with an empty result rather than failing).
    const live = service.getSessionInteractions('live-only');
    expect(live.ok && live.value.length > 0).toBe(true);
    const arch = service.getSessionInteractions('arch-only');
    expect(arch.ok && arch.value.length === 0).toBe(true);
    service.dispose();
  });
});
