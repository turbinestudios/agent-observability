import { describe, it, expect } from 'vitest';
import { buildUiState } from './uiState';
import { CLAUDE_EFFORT_LEVELS, CLAUDE_MODEL_CHOICES } from './claudeCliArgs';

const BACKENDS = [
  { id: 'copilot', label: 'GitHub Copilot', available: true },
  { id: 'claude-code', label: 'Claude Code', available: true },
];

describe('buildUiState', () => {
  it('offers efforts only when Claude Code is active', () => {
    const claude = buildUiState({
      backends: BACKENDS,
      activeBackend: 'claude-code',
      models: [...CLAUDE_MODEL_CHOICES],
      activeModel: 'sonnet',
      activeEffort: 'high',
    });
    expect(claude.efforts).toEqual(CLAUDE_EFFORT_LEVELS);
    expect(claude.activeEffort).toBe('high');

    const copilot = buildUiState({
      backends: BACKENDS,
      activeBackend: 'copilot',
      models: [{ id: 'gpt-4o', label: 'GPT-4o' }],
      activeModel: '',
      activeEffort: 'high',
    });
    expect(copilot.efforts).toBeUndefined();
    expect(copilot.activeEffort).toBeUndefined();
  });

  it('appends a hand-configured Claude model as a (custom) choice', () => {
    const state = buildUiState({
      backends: BACKENDS,
      activeBackend: 'claude-code',
      models: [...CLAUDE_MODEL_CHOICES],
      activeModel: 'claude-sonnet-5',
      activeEffort: 'high',
    });
    expect(state.models.at(-1)).toEqual({ id: 'claude-sonnet-5', label: 'claude-sonnet-5 (custom)' });
  });

  it('does not duplicate a configured model that is already offered', () => {
    const state = buildUiState({
      backends: BACKENDS,
      activeBackend: 'claude-code',
      models: [...CLAUDE_MODEL_CHOICES],
      activeModel: 'opus',
      activeEffort: 'max',
    });
    expect(state.models.filter((m) => m.id === 'opus')).toHaveLength(1);
  });

  it('leaves an unknown Copilot model to fall back to auto instead of appending it', () => {
    const state = buildUiState({
      backends: BACKENDS,
      activeBackend: 'copilot',
      models: [{ id: 'gpt-4o', label: 'GPT-4o' }],
      activeModel: 'stale-model-id',
      activeEffort: 'high',
    });
    expect(state.models.map((m) => m.id)).toEqual(['gpt-4o']);
  });

  it('carries unavailable-backend hints through untouched', () => {
    const state = buildUiState({
      backends: [
        { id: 'copilot', label: 'GitHub Copilot', available: true },
        { id: 'claude-code', label: 'Claude Code', available: false, hint: 'CLI not found' },
      ],
      activeBackend: 'copilot',
      models: [],
      activeModel: '',
      activeEffort: 'high',
    });
    expect(state.backends[1]).toEqual({
      id: 'claude-code',
      label: 'Claude Code',
      available: false,
      hint: 'CLI not found',
    });
  });
});
