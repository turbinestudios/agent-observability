import { describe, it, expect } from 'vitest';
import {
  ContextFiles,
  QUICK_COMMANDS,
  getQuickCommand,
  selectContextForFreeText,
} from './quickCommands';

describe('quick commands', () => {
  it('ships exactly the three documented commands in order', () => {
    expect(QUICK_COMMANDS.map((c) => c.id)).toEqual([
      'generate-workflows',
      'minimal-config',
      'summarize-logs',
    ]);
  });

  it('every command has a label, prompt and at least the overview context', () => {
    for (const c of QUICK_COMMANDS) {
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.prompt.length).toBeGreaterThan(0);
      expect(c.contextFiles).toContain(ContextFiles.overview);
    }
  });

  it('selects the workflow DSL only for the workflow command', () => {
    expect(getQuickCommand('generate-workflows')?.contextFiles).toContain(ContextFiles.workflowDsl);
    expect(getQuickCommand('minimal-config')?.contextFiles).not.toContain(ContextFiles.workflowDsl);
  });

  it('returns undefined for an unknown id', () => {
    expect(getQuickCommand('nope')).toBeUndefined();
  });
});

describe('free-text context selection', () => {
  it('always includes overview + settings reference', () => {
    const files = selectContextForFreeText('hello');
    expect(files).toContain(ContextFiles.overview);
    expect(files).toContain(ContextFiles.settingsReference);
  });

  it('adds the workflow DSL when the question mentions workflows', () => {
    expect(selectContextForFreeText('how do I define a workflow?')).toContain(
      ContextFiles.workflowDsl,
    );
  });

  it('adds the telemetry glossary when the question mentions tokens/logs', () => {
    expect(selectContextForFreeText('summarize my token usage')).toContain(
      ContextFiles.telemetryGlossary,
    );
  });

  it('does not duplicate files', () => {
    const files = selectContextForFreeText('workflow tokens session log');
    expect(new Set(files).size).toBe(files.length);
  });
});
