import { describe, it, expect } from 'vitest';
import { extractConfigResponse, filterKnownConfigKeys } from './minimalConfig';

describe('filterKnownConfigKeys', () => {
  it('keeps known agentObservability keys and drops unknowns', () => {
    const { kept, dropped } = filterKnownConfigKeys({
      'agentObservability.localTelemetry.enabled': true,
      'agentObservability.madeUpKey': 1,
      'editor.fontSize': 14,
    });
    expect(kept).toEqual({ 'agentObservability.localTelemetry.enabled': true });
    expect(dropped.sort()).toEqual(['agentObservability.madeUpKey', 'editor.fontSize']);
  });
});

describe('extractConfigResponse', () => {
  it('extracts and filters an ao-config object', () => {
    const response =
      'Minimal config:\n\n```ao-config\n{ "agentObservability.localTelemetry.enabled": true, "foo": 1 }\n```';
    const r = extractConfigResponse(response);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.settings).toEqual({ 'agentObservability.localTelemetry.enabled': true });
      expect(r.dropped).toEqual(['foo']);
    }
  });

  it('rejects a missing block, invalid JSON, or a non-object', () => {
    expect(extractConfigResponse('no block').ok).toBe(false);
    expect(extractConfigResponse('```ao-config\n{bad\n```').ok).toBe(false);
    expect(extractConfigResponse('```ao-config\n[1,2]\n```').ok).toBe(false);
  });
});
