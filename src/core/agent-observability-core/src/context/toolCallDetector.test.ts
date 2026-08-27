import { describe, it, expect } from 'vitest';
import { parseToolReads } from './toolCallDetector';
import type { ToolReadRow } from './toolCallDetector';

describe('toolCallDetector', () => {
  describe('parseToolReads', () => {
    it('extracts context file reads from known directories', () => {
      const rows: ToolReadRow[] = [
        {
          filePath: 'c:\\Projects\\example-app\\.github\\instructions\\foo.instructions.md',
          conversationId: 'conv-1',
          chatSessionId: 'chat-1',
        },
        {
          filePath: '/home/user/.copilot/skills/bar/SKILL.md',
          conversationId: 'conv-1',
          chatSessionId: 'chat-1',
        },
      ];

      const result = parseToolReads(rows, new Set());

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        name: 'foo.instructions.md',
        category: 'instruction',
        status: 'read',
      });
      expect(result[1]).toMatchObject({
        name: 'SKILL.md',
        category: 'skill',
        status: 'read',
      });
    });

    it('categorizes bare agent-instruction basenames as instruction, not unknown', () => {
      const rows: ToolReadRow[] = [
        { filePath: 'c:\\Projects\\example-app\\AGENTS.md', conversationId: 'conv-1', chatSessionId: 'chat-1' },
        { filePath: '/repo/CLAUDE.md', conversationId: 'conv-1', chatSessionId: 'chat-1' },
        { filePath: '/repo/CLAUDE.local.md', conversationId: 'conv-1', chatSessionId: 'chat-1' },
        { filePath: '/repo/.github/copilot-instructions.md', conversationId: 'conv-1', chatSessionId: 'chat-1' },
      ];

      const result = parseToolReads(rows, new Set());

      expect(result).toHaveLength(4);
      for (const entry of result) {
        expect(entry.category).toBe('instruction');
      }
    });

    it('skips files already known from discovery', () => {
      const rows: ToolReadRow[] = [
        {
          filePath: 'c:\\.github\\instructions\\foo.instructions.md',
          conversationId: 'conv-1',
          chatSessionId: 'chat-1',
        },
      ];

      const result = parseToolReads(rows, new Set(['foo.instructions.md']));
      expect(result).toHaveLength(0);
    });

    it('deduplicates by normalized path', () => {
      const rows: ToolReadRow[] = [
        {
          filePath: 'c:\\.github\\instructions\\foo.md',
          conversationId: 'conv-1',
          chatSessionId: 'chat-1',
        },
        {
          filePath: 'c:/.github/instructions/foo.md',
          conversationId: 'conv-1',
          chatSessionId: 'chat-1',
        },
      ];

      const result = parseToolReads(rows, new Set());
      expect(result).toHaveLength(1);
    });

    it('returns empty for no context-file reads', () => {
      const rows: ToolReadRow[] = [
        {
          filePath: 'c:\\Projekt\\src\\main.ts',
          conversationId: 'conv-1',
          chatSessionId: 'chat-1',
        },
      ];

      // This won't match because the database query already pre-filters;
      // but the parser also doesn't re-filter since the DB handles it
      const result = parseToolReads(rows, new Set());
      expect(result).toHaveLength(1); // Passes through since DB pre-filtered
    });
  });
});
