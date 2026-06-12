import { describe, it, expect } from 'vitest';
import { parseDiscoveryEvents } from './discoveryParser';
import type { DiscoveryEventRow } from './discoveryParser';

describe('discoveryParser', () => {
  describe('parseDiscoveryEvents', () => {
    it('parses an Instructions Discovery event', () => {
      const events: DiscoveryEventRow[] = [
        {
          spanName: 'Instructions Discovery',
          eventDetails:
            'Resolved 14 instructions in 126.3ms | loaded: [ai-reflection-agent-model-naming, monorepo-structure] | folders: [/c:/Users/.copilot/instructions]',
          eventCategory: 'discovery',
          conversationId: 'conv-1',
          chatSessionId: 'chat-1',
        },
      ];

      const result = parseDiscoveryEvents(events);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        name: 'ai-reflection-agent-model-naming',
        category: 'instruction',
        status: 'applied',
      });
      expect(result[1]).toEqual({
        name: 'monorepo-structure',
        category: 'instruction',
        status: 'applied',
      });
    });

    it('parses a Skill Discovery event with skipped entries', () => {
      const events: DiscoveryEventRow[] = [
        {
          spanName: 'Skill Discovery',
          eventDetails:
            'Resolved 15 skills in 31.6ms | loaded: [reflect, excalidraw-diagram-generator] | skipped: [file:///c%3A/Users/.claude/skills/reflect/SKILL.md (duplicate-name)] | folders: [/c:/Users/.copilot/skills]',
          eventCategory: 'discovery',
          conversationId: 'conv-1',
          chatSessionId: 'chat-1',
        },
      ];

      const result = parseDiscoveryEvents(events);

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({
        name: 'reflect',
        category: 'skill',
        status: 'applied',
      });
      expect(result[1]).toEqual({
        name: 'excalidraw-diagram-generator',
        category: 'skill',
        status: 'applied',
      });
      expect(result[2]).toEqual({
        name: 'SKILL.md',
        category: 'skill',
        status: 'skipped',
        skipReason: 'duplicate-name',
      });
    });

    it('parses a customization-resolution event with applied and skipped files', () => {
      const events: DiscoveryEventRow[] = [
        {
          spanName: 'Resolve Customizations',
          eventDetails:
            "[skipped] ai-reflection-agent-model-naming.instructions.md — applyTo '.github/agents/**' did not match any attached files, [applying] copilot-instructions.md — always added, [applying] CLAUDE.md — always added",
          eventCategory: 'customization',
          conversationId: 'conv-1',
          chatSessionId: 'chat-1',
        },
      ];

      const result = parseDiscoveryEvents(events);

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({
        name: 'ai-reflection-agent-model-naming.instructions.md',
        category: 'instruction',
        status: 'skipped',
        skipReason: "applyTo '.github/agents/**' did not match any attached files",
      });
      expect(result[1]).toEqual({
        name: 'copilot-instructions.md',
        category: 'instruction',
        status: 'applied',
        skipReason: undefined,
      });
      expect(result[2]).toEqual({
        name: 'CLAUDE.md',
        category: 'instruction',
        status: 'applied',
        skipReason: undefined,
      });
    });

    it('parses an Agent Discovery event', () => {
      const events: DiscoveryEventRow[] = [
        {
          spanName: 'Agent Discovery',
          eventDetails:
            'Resolved 3 agents in 16.9ms | loaded: [Architecture, Backend, Frontend] | folders: [/c:/Users/.copilot/agents]',
          eventCategory: 'discovery',
          conversationId: 'conv-1',
          chatSessionId: 'chat-1',
        },
      ];

      const result = parseDiscoveryEvents(events);

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ name: 'Architecture', category: 'agent', status: 'applied' });
      expect(result[1]).toEqual({ name: 'Backend', category: 'agent', status: 'applied' });
      expect(result[2]).toEqual({ name: 'Frontend', category: 'agent', status: 'applied' });
    });

    it('parses a Hook Discovery event with skipped hooks', () => {
      const events: DiscoveryEventRow[] = [
        {
          spanName: 'Hook Discovery',
          eventDetails:
            'Resolved 1 hooks from 1 files in 23.2ms, skipped 2 | loaded: [require-tests.json] | skipped: [file:///c%3A/Users/.claude/settings.json (claude-hooks-disabled), file:///c%3A/Projekt/.claude/settings.local.json (claude-hooks-disabled)] | folders: [/c:/Users/.copilot/hooks]',
          eventCategory: 'discovery',
          conversationId: 'conv-1',
          chatSessionId: 'chat-1',
        },
      ];

      const result = parseDiscoveryEvents(events);

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ name: 'require-tests.json', category: 'hook', status: 'applied' });
      expect(result[1]).toEqual({
        name: 'settings.json',
        category: 'hook',
        status: 'skipped',
        skipReason: 'claude-hooks-disabled',
      });
      expect(result[2]).toEqual({
        name: 'settings.local.json',
        category: 'hook',
        status: 'skipped',
        skipReason: 'claude-hooks-disabled',
      });
    });

    it('returns empty array for empty input', () => {
      expect(parseDiscoveryEvents([])).toEqual([]);
    });

    it('handles event with empty loaded list', () => {
      const events: DiscoveryEventRow[] = [
        {
          spanName: 'Instructions Discovery',
          eventDetails: 'Resolved 0 instructions in 5.0ms | loaded: [] | folders: [/c:/foo]',
          eventCategory: 'discovery',
          conversationId: 'conv-1',
          chatSessionId: 'chat-1',
        },
      ];

      const result = parseDiscoveryEvents(events);
      expect(result).toEqual([]);
    });

    it('infers category from eventDetails when spanName is empty', () => {
      const events: DiscoveryEventRow[] = [
        {
          spanName: '',
          eventDetails:
            'Resolved 14 instructions in 126.3ms | loaded: [ai-reflection, monorepo-structure] | folders: [/c:/Users/.copilot/instructions]',
          eventCategory: 'discovery',
          conversationId: 'conv-1',
          chatSessionId: 'chat-1',
        },
        {
          spanName: '',
          eventDetails:
            'Resolved 3 skills in 10.0ms | loaded: [reflect, diagram-gen] | folders: [/c:/Users/.copilot/skills]',
          eventCategory: 'discovery',
          conversationId: 'conv-1',
          chatSessionId: 'chat-1',
        },
      ];

      const result = parseDiscoveryEvents(events);

      expect(result).toHaveLength(4);
      expect(result[0]).toEqual({ name: 'ai-reflection', category: 'instruction', status: 'applied' });
      expect(result[1]).toEqual({ name: 'monorepo-structure', category: 'instruction', status: 'applied' });
      expect(result[2]).toEqual({ name: 'reflect', category: 'skill', status: 'applied' });
      expect(result[3]).toEqual({ name: 'diagram-gen', category: 'skill', status: 'applied' });
    });
  });
});
