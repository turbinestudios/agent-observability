import { describe, it, expect } from 'vitest';
import { analyzeContext } from './contextAnalyzer';
import type { TelemetryService, Result } from '../telemetry/telemetryService';
import type { DiscoveryEventRow } from './discoveryParser';
import { renderSessionDetailHtml } from '../views/sessionDetailHtml';

/**
 * Minimal fake TelemetryService that returns configurable context data.
 * Only the methods called by analyzeContext are implemented.
 */
function fakeTelemetry(opts: {
  discoveryEvents?: DiscoveryEventRow[];
  toolReads?: Array<{ filePath: string; conversationId: string | null; chatSessionId: string | null; agentName: string | null; debugLabel: string | null }>;
  systemInstrMap?: Map<string, { value: string; conversationId: string | null; chatSessionId: string | null; inputTokens: number; agentName: string | null; debugLabel: string | null }>;
  subagentNames?: Map<string, string>;
}): TelemetryService {
  return {
    getContextDiscoveryEvents(): Result<DiscoveryEventRow[]> {
      return { ok: true, value: opts.discoveryEvents ?? [] };
    },
    getContextToolReads(): Result<Array<{ filePath: string; conversationId: string | null; chatSessionId: string | null; agentName: string | null; debugLabel: string | null }>> {
      return { ok: true, value: opts.toolReads ?? [] };
    },
    getSystemInstructionsBySpan(): Result<Map<string, { value: string; conversationId: string | null; chatSessionId: string | null; inputTokens: number; agentName: string | null; debugLabel: string | null }>> {
      return { ok: true, value: opts.systemInstrMap ?? new Map() };
    },
    getSubagentNames(): Result<Map<string, string>> {
      return { ok: true, value: opts.subagentNames ?? new Map() };
    },
  } as unknown as TelemetryService;
}

describe('analyzeContext — subagent name assignment', () => {
  it('classifies a subagent system_instructions span via debug_log_label', () => {
    // Real scenario: a subagent chat span has agent_name=tool/runSubagent and
    // debug_label=runSubagent-Backend. The partitioner should create a single
    // "Sub-agent: Backend" partition for it.
    const systemInstrMap = new Map([
      ['span-1', {
        value: 'You are a subagent.',
        conversationId: 'sub-conv-1',
        chatSessionId: 'root-chat',
        inputTokens: 5000,
        agentName: 'tool/runSubagent',
        debugLabel: 'runSubagent-Backend',
      }],
    ]);

    const telemetry = fakeTelemetry({ systemInstrMap });
    const result = analyzeContext('session-key', telemetry);

    expect(result).toBeDefined();
    const subagentPartition = result!.agents.find((a) => a.kind === 'subagent');
    expect(subagentPartition).toBeDefined();
    expect(subagentPartition!.agentName).toBe('Sub-agent: Backend');
  });

  it('groups multiple subagent classifications by friendly name', () => {
    const systemInstrMap = new Map([
      ['span-1', {
        value: 'A', conversationId: 'sub-conv-1', chatSessionId: 'root-chat',
        inputTokens: 5000, agentName: 'tool/runSubagent', debugLabel: 'runSubagent-Backend',
      }],
      ['span-2', {
        value: 'B', conversationId: 'sub-conv-2', chatSessionId: 'root-chat',
        inputTokens: 6000, agentName: 'tool/runSubagent', debugLabel: 'runSubagent-Frontend',
      }],
    ]);

    const telemetry = fakeTelemetry({ systemInstrMap });
    const result = analyzeContext('session-key', telemetry);

    expect(result).toBeDefined();
    const subagents = result!.agents.filter((a) => a.kind === 'subagent');
    expect(subagents.length).toBe(2);
    const names = subagents.map((s) => s.agentName).sort();
    expect(names).toContain('Sub-agent: Backend');
    expect(names).toContain('Sub-agent: Frontend');
  });

  it('uses agent_name fallback when debug_label has no runSubagent prefix', () => {
    const systemInstrMap = new Map([
      ['span-1', {
        value: 'A', conversationId: 'sub-conv-1', chatSessionId: 'root-chat',
        inputTokens: 5000, agentName: 'tool/runSubagent', debugLabel: null,
      }],
    ]);

    const telemetry = fakeTelemetry({ systemInstrMap });
    const result = analyzeContext('session-key', telemetry);

    expect(result).toBeDefined();
    const subagent = result!.agents.find((a) => a.kind === 'subagent');
    expect(subagent).toBeDefined();
    // Falls back to the raw agent_name when no usable debug label is present
    expect(subagent!.agentName).toBe('tool/runSubagent');
  });

  it('orphan discovery events (no agent_name/debug_label, null IDs) go to Main Agent', () => {
    // Discovery events from core_event spans often lack classification fields.
    // Without any conversation-id mapping to a subagent, they default to main.
    const discoveryEvents: DiscoveryEventRow[] = [
      {
        spanName: 'core_event',
        eventDetails: JSON.stringify({
          event: 'copilot_customization',
          type: 'instructions',
          filename: 'copilot-instructions.md',
          loadedContent: 'main instructions',
        }),
        eventCategory: 'copilot_customization',
        conversationId: null,
        chatSessionId: null,
        agentName: null,
        debugLabel: null,
      },
    ];

    const telemetry = fakeTelemetry({ discoveryEvents });
    const result = analyzeContext('session-key', telemetry);

    expect(result).toBeDefined();
    const mainPartition = result!.agents.find((a) => a.kind === 'main');
    expect(mainPartition).toBeDefined();
    expect(mainPartition!.agentName).toBe('Main Agent');
    const subagents = result!.agents.filter((a) => a.kind === 'subagent');
    expect(subagents.length).toBe(0);
  });

  it('preserves "Main Agent" for events with non-runSubagent agent_name', () => {
    // panel/editAgent (the normal main-thread agent) should never be classified
    // as a subagent, regardless of conversation_id.
    const systemInstrMap = new Map([
      ['main-span', {
        value: 'main prompt', conversationId: 'shared-conv', chatSessionId: 'root-chat',
        inputTokens: 50000, agentName: 'panel/editAgent', debugLabel: null,
      }],
    ]);

    const telemetry = fakeTelemetry({ systemInstrMap });
    const result = analyzeContext('session-key', telemetry, undefined, undefined, ['Sub-agent: Test']);

    expect(result).toBeDefined();
    const mainPartition = result!.agents.find((a) => a.kind === 'main');
    expect(mainPartition).toBeDefined();
    expect(mainPartition!.agentName).toBe('Main Agent');
    expect(mainPartition!.totalContextTokens).toBe(50000);
    // The subagent name should NOT be used for main
    const subagents = result!.agents.filter((a) => a.kind === 'subagent');
    expect(subagents.length).toBe(0);
  });

  it('merges multiple invocations of the same subagent into one partition', () => {
    // Same subagent (same friendly name) invoked 4 times — each invocation
    // produces system_instructions spans tagged with the subagent's debug
    // label. The Context Analysis tab should show only one collapsible per
    // agent name, matching the Overview tab.
    const rootChatId = 'root-chat-session';
    const subDebugLabel = 'runSubagent-Backend';
    const systemInstrMap = new Map([
      ['span-a', { value: 'agent prompt A', conversationId: 'sub-conv-1', chatSessionId: rootChatId, inputTokens: 24319, agentName: 'tool/runSubagent', debugLabel: subDebugLabel }],
      ['span-b', { value: 'agent prompt B', conversationId: 'sub-conv-2', chatSessionId: rootChatId, inputTokens: 31818, agentName: 'tool/runSubagent', debugLabel: subDebugLabel }],
      ['span-c', { value: 'agent prompt C', conversationId: 'sub-conv-3', chatSessionId: rootChatId, inputTokens: 21202, agentName: 'tool/runSubagent', debugLabel: subDebugLabel }],
      ['span-d', { value: 'agent prompt D', conversationId: 'sub-conv-4', chatSessionId: rootChatId, inputTokens: 83380, agentName: 'tool/runSubagent', debugLabel: subDebugLabel }],
    ]);

    const telemetry = fakeTelemetry({ systemInstrMap });
    const result = analyzeContext('session-key', telemetry);

    expect(result).toBeDefined();
    const subagents = result!.agents.filter((a) => a.kind === 'subagent');
    // Should be ONE partition, not four
    expect(subagents.length).toBe(1);
    expect(subagents[0].agentName).toBe('Sub-agent: Backend');
    // The largest input_tokens sample (83380) should be the representative.
    expect(subagents[0].totalContextTokens).toBe(83380);
  });

  it('keeps distinct subagent partitions when names differ', () => {
    const rootChatId = 'root-chat-session';
    const systemInstrMap = new Map([
      ['span-a', { value: 'A', conversationId: 'sub-conv-1', chatSessionId: rootChatId, inputTokens: 1000, agentName: 'tool/runSubagent', debugLabel: 'runSubagent-Backend' }],
      ['span-b', { value: 'B', conversationId: 'sub-conv-2', chatSessionId: rootChatId, inputTokens: 2000, agentName: 'tool/runSubagent', debugLabel: 'runSubagent-Frontend' }],
    ]);

    const telemetry = fakeTelemetry({ systemInstrMap });
    const result = analyzeContext('session-key', telemetry);

    expect(result).toBeDefined();
    const subagents = result!.agents.filter((a) => a.kind === 'subagent');
    expect(subagents.length).toBe(2);
    const names = subagents.map((s) => s.agentName).sort();
    expect(names).toEqual(['Sub-agent: Backend', 'Sub-agent: Frontend']);
  });

  it('creates a Main Agent partition with input_tokens from main chat spans', () => {
    // Real-session pattern: chat spans for both main and subagent share the
    // same chat_session_id, but the main spans are tagged with a non-runSubagent
    // agent_name. The Main Agent partition must show the main spans' tokens.
    const rootChatId = 'root-chat-session';
    const systemInstrMap = new Map([
      ['main-span-1', { value: 'main prompt', conversationId: 'shared-conv', chatSessionId: rootChatId, inputTokens: 50000, agentName: 'panel/editAgent', debugLabel: null }],
      ['sub-span-1', { value: 'sub prompt', conversationId: 'shared-conv', chatSessionId: rootChatId, inputTokens: 25000, agentName: 'tool/runSubagent', debugLabel: 'runSubagent-Backend' }],
    ]);

    const telemetry = fakeTelemetry({ systemInstrMap });
    const result = analyzeContext('session-key', telemetry);

    expect(result).toBeDefined();
    const main = result!.agents.find((a) => a.kind === 'main');
    expect(main).toBeDefined();
    expect(main!.agentName).toBe('Main Agent');
    expect(main!.totalContextTokens).toBe(50000);

    const sub = result!.agents.find((a) => a.kind === 'subagent');
    expect(sub).toBeDefined();
    expect(sub!.agentName).toBe('Sub-agent: Backend');
    expect(sub!.totalContextTokens).toBe(25000);
  });

  it('renders the assigned subagent name in the HTML output', () => {
    // Integration: end-to-end from analyzeContext → HTML rendering
    const detail = {
      summary: {
        sessionId: 'test-id',
        repository: 'test/repo',
        startedAtMs: 1700000000000,
        endedAtMs: 1700000060000,
        durationMs: 60000,
        interactionCount: 1,
        llmCalls: 1,
        toolCalls: 0,
        inputTokens: 10000,
        outputTokens: 500,
        cachedTokens: 0,
        model: 'gpt-4',
        agentModes: ['agent'],
      },
      treeStats: {
        modelTurns: 1,
        toolCalls: 0,
        inputTokens: 10000,
        outputTokens: 500,
        cachedTokens: 0,
        totalTokens: 10500,
        errorCount: 0,
        aiuNano: 0,
        linesOfCode: 0,
        linesOfDoc: 0,
        linesOfCodeRemoved: 0,
        linesOfDocRemoved: 0,
      },
      turns: [],
      modelUsage: [],
      agentUsage: [],
      treeModelTurns: [],
    } as any;

    // Build a context analysis with a named subagent
    const contextAnalysis = {
      total: {
        agentName: 'Total Overview',
        kind: 'total' as const,
        loadedFiles: [],
        expectedMissing: [],
        totalContextTokens: 5000,
        contextFileTokens: 500,
        otherContextTokens: 4500,
        oversizedFiles: [],
      },
      agents: [
        {
          agentName: 'Main Agent',
          kind: 'main' as const,
          loadedFiles: [],
          expectedMissing: [],
          totalContextTokens: 5000,
          contextFileTokens: 500,
          otherContextTokens: 4500,
          oversizedFiles: [],
        },
        {
          agentName: 'Sub-agent: Backend',
          kind: 'subagent' as const,
          loadedFiles: [
            { name: 'backend.instructions.md', category: 'instruction' as const, status: 'applied' as const, estimatedTokens: 200, charCount: 800 },
          ],
          expectedMissing: [],
          totalContextTokens: 3000,
          contextFileTokens: 200,
          otherContextTokens: 2800,
          oversizedFiles: [],
        },
      ],
    };

    const html = renderSessionDetailHtml(detail, [], 'test-nonce', contextAnalysis);
    // The collapsible summary should show "Sub-agent: Backend" not generic "Sub-agent"
    expect(html).toContain('Sub-agent: Backend');
  });
});

describe('analyzeContext — system-prompt <file> signal', () => {
  it('surfaces customization files listed in the system prompt when no discovery events exist', () => {
    // The otlp-http live-updates stream never emits discovery core_event spans,
    // so the system prompt's <file> list is the only signal that a customization
    // file reached the context window. This is exactly the case that the Context
    // Hotspots view shows but the tab previously missed.
    const systemInstrMap = new Map([
      ['span-1', {
        value: [
          '<instructions>',
          '<instruction><file>c:\\repo\\.github\\instructions\\security.instructions.md</file></instruction>',
          '</instructions>',
        ].join('\n'),
        conversationId: 'conv-1',
        chatSessionId: 'root-chat',
        inputTokens: 12000,
        agentName: null,
        debugLabel: null,
      }],
    ]);

    const telemetry = fakeTelemetry({ systemInstrMap });
    const result = analyzeContext('session-key', telemetry);

    expect(result).toBeDefined();
    const main = result!.agents.find((a) => a.kind === 'main')!;
    const entry = main.loadedFiles.find((f) => f.name === 'security.instructions.md');
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('applied');
    expect(entry!.category).toBe('instruction');
  });

  it('does not duplicate a system-prompt file already detected via a tool read (same path)', () => {
    const filePath = 'c:\\repo\\.github\\instructions\\security.instructions.md';
    const toolReads = [
      { filePath, conversationId: null, chatSessionId: null, agentName: null, debugLabel: null },
    ];
    const systemInstrMap = new Map([
      ['span-1', {
        value: `<file>${filePath}</file>`,
        conversationId: null,
        chatSessionId: null,
        inputTokens: 8000,
        agentName: null,
        debugLabel: null,
      }],
    ]);

    const telemetry = fakeTelemetry({ toolReads, systemInstrMap });
    const result = analyzeContext('session-key', telemetry);

    expect(result).toBeDefined();
    const main = result!.agents.find((a) => a.kind === 'main')!;
    const matching = main.loadedFiles.filter((f) => f.name === 'security.instructions.md');
    expect(matching.length).toBe(1);
  });

  it('keeps distinct SKILL.md skills listed in the system prompt', () => {
    // Every skill's file is named SKILL.md, so distinct skills must be told apart
    // by path — deduping by base name would collapse them into one.
    const systemInstrMap = new Map([
      ['span-1', {
        value: [
          '<file>c:\\repo\\.github\\skills\\tour\\SKILL.md</file>',
          '<file>c:\\repo\\.github\\skills\\review\\SKILL.md</file>',
        ].join('\n'),
        conversationId: null,
        chatSessionId: null,
        inputTokens: 9000,
        agentName: null,
        debugLabel: null,
      }],
    ]);

    const telemetry = fakeTelemetry({ systemInstrMap });
    const result = analyzeContext('session-key', telemetry);

    expect(result).toBeDefined();
    const main = result!.agents.find((a) => a.kind === 'main')!;
    const skillFiles = main.loadedFiles.filter((f) => f.name === 'SKILL.md');
    expect(skillFiles.length).toBe(2);
    expect(new Set(skillFiles.map((f) => f.filePath)).size).toBe(2);
  });
});
