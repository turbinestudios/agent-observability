import { describe, expect, it } from 'vitest';
import type { CopilotConfigTarget } from '@agent-observability/core/src/telemetry/paths';
import type { CopilotSetupTarget, CopilotTraceState } from '../shared/rpc';
import {
  COPILOT_SETUP_AUTO_APPLY_KEY,
  COPILOT_SETUP_DISMISS_KEY,
  checkCopilotSetup,
  enableCopilotTracing,
  shouldPromptForSetup,
  startupCopilotSetup,
} from './copilotSetup';
import type { CopilotSetupSeams } from './copilotSetup';

const SETTING = 'github.copilot.chat.otel.dbSpanExporter.enabled';

function target(
  variant: string,
  settingsFile: string,
  dbKind: CopilotConfigTarget['dbKind'] = 'absent',
): CopilotConfigTarget {
  return {
    variant,
    source: variant === 'Code' ? 'stable' : 'variant',
    userDir: `${variant}/User`,
    settingsFile,
    dbPath: `${variant}/db`,
    dbKind,
  };
}

function fakeSettings(values: Record<string, unknown> = {}): {
  get<T>(key: string, defaultValue: T): T;
} {
  return {
    get<T>(key: string, defaultValue: T): T {
      const found = values[key];
      return found === undefined ? defaultValue : (found as T);
    },
  };
}

const sourceOn = { isLocalTelemetryEnabled: () => true };
const sourceOff = { isLocalTelemetryEnabled: () => false };

/** Seams over in-memory files. Missing entries throw ENOENT; `denied` throws EACCES. */
function fakeIo(
  targets: CopilotConfigTarget[],
  files: Record<string, string>,
  opts: { deniedReads?: string[]; deniedWrites?: string[] } = {},
): { seams: CopilotSetupSeams; written: Map<string, string> } {
  const written = new Map<string, string>();
  const seams: CopilotSetupSeams = {
    targets: () => targets,
    readFile: (file) => {
      if (opts.deniedReads?.includes(file) === true) {
        throw Object.assign(new Error(`EACCES: permission denied '${file}'`), { code: 'EACCES' });
      }
      const text = written.get(file) ?? files[file];
      if (text === undefined) {
        throw Object.assign(new Error(`ENOENT: no such file '${file}'`), { code: 'ENOENT' });
      }
      return text;
    },
    writeFile: (file, text) => {
      if (opts.deniedWrites?.includes(file) === true) {
        throw Object.assign(new Error(`EACCES: permission denied '${file}'`), { code: 'EACCES' });
      }
      written.set(file, text);
    },
  };
  return { seams, written };
}

function stateOf(text: string | undefined): CopilotTraceState {
  const file = 'Code/User/settings.json';
  const { seams } = fakeIo([target('Code', file)], text === undefined ? {} : { [file]: text });
  return checkCopilotSetup(fakeSettings(), sourceOn, seams).targets[0].state;
}

describe('checkCopilotSetup classification', () => {
  it('classifies true as enabled', () => {
    expect(stateOf(`{ "${SETTING}": true }`)).toBe('enabled');
  });

  it('classifies explicit false as disabled', () => {
    expect(stateOf(`{ "${SETTING}": false }`)).toBe('disabled');
  });

  it('classifies an absent key as unset', () => {
    expect(stateOf('{ "editor.fontSize": 14 }')).toBe('unset');
  });

  it('classifies a missing file as no-settings-file', () => {
    expect(stateOf(undefined)).toBe('no-settings-file');
  });

  it('classifies an empty file as unset', () => {
    expect(stateOf('')).toBe('unset');
  });

  it('parses VS Code JSONC: comments and a trailing comma', () => {
    const text = `{
    // my settings
    "editor.fontSize": 14, /* block */
    "${SETTING}": true,
}`;
    expect(stateOf(text)).toBe('enabled');
  });

  it('classifies broken JSON as unparseable, with a detail', () => {
    const file = 'Code/User/settings.json';
    const { seams } = fakeIo([target('Code', file)], { [file]: '{ "a": }' });
    const t = checkCopilotSetup(fakeSettings(), sourceOn, seams).targets[0];
    expect(t.state).toBe('unparseable');
    expect(t.detail).toContain('could not be parsed');
  });

  it('classifies a non-object root as unparseable', () => {
    expect(stateOf('[1, 2]')).toBe('unparseable');
  });

  it('classifies an unreadable file as denied, with the error text', () => {
    const file = 'Code/User/settings.json';
    const { seams } = fakeIo([target('Code', file)], {}, { deniedReads: [file] });
    const t = checkCopilotSetup(fakeSettings(), sourceOn, seams).targets[0];
    expect(t.state).toBe('denied');
    expect(t.detail).toContain('EACCES');
  });

  it('labels well-known variants and carries dbExists', () => {
    const targets = [
      target('Code', 'a.json', 'file'),
      target('Cursor', 'b.json'),
    ];
    const { seams } = fakeIo(targets, { 'a.json': '{}', 'b.json': '{}' });
    const status = checkCopilotSetup(fakeSettings(), sourceOn, seams);
    expect(status.targets.map((t) => t.variantLabel)).toEqual(['VS Code', 'Cursor']);
    expect(status.targets.map((t) => t.dbExists)).toEqual([true, false]);
  });
});

describe('shouldPromptForSetup', () => {
  const fixable: CopilotSetupTarget = {
    variant: 'Code',
    variantLabel: 'VS Code',
    settingsFile: 'f',
    state: 'unset',
    dbExists: false,
  };

  it('prompts when a fixable target exists and nothing traces yet', () => {
    expect(shouldPromptForSetup([fixable], true, false)).toBe(true);
  });

  it('stays quiet when dismissed', () => {
    expect(shouldPromptForSetup([fixable], true, true)).toBe(false);
  });

  it('stays quiet when the Copilot source is off in this app', () => {
    expect(shouldPromptForSetup([fixable], false, false)).toBe(false);
  });

  it('stays quiet with no targets', () => {
    expect(shouldPromptForSetup([], true, false)).toBe(false);
  });

  it('stays quiet when any editor already has tracing on', () => {
    const enabled = { ...fixable, state: 'enabled' as const };
    expect(shouldPromptForSetup([fixable, enabled], true, false)).toBe(false);
  });

  it('stays quiet when any editor already holds a database', () => {
    const withDb = { ...fixable, settingsFile: 'g', dbExists: true };
    expect(shouldPromptForSetup([fixable, withDb], true, false)).toBe(false);
  });

  it('stays quiet when every target is unfixable', () => {
    const broken = { ...fixable, state: 'unparseable' as const };
    const locked = { ...fixable, settingsFile: 'g', state: 'denied' as const };
    expect(shouldPromptForSetup([broken, locked], true, false)).toBe(false);
  });
});

describe('enableCopilotTracing', () => {
  const file = 'Code/User/settings.json';

  it('creates a valid settings file where none existed', () => {
    const { seams, written } = fakeIo([target('Code', file)], {});
    const r = enableCopilotTracing([file], fakeSettings(), sourceOn, seams);
    expect(r.results).toEqual([{ settingsFile: file, ok: true, detail: 'Tracing switched on.' }]);
    expect(JSON.parse(written.get(file) ?? '')).toEqual({ [SETTING]: true });
    expect(r.status.targets[0].state).toBe('enabled');
  });

  it('flips an explicit false in place', () => {
    const { seams, written } = fakeIo([target('Code', file)], {
      [file]: `{ "${SETTING}": false }`,
    });
    const r = enableCopilotTracing([file], fakeSettings(), sourceOn, seams);
    expect(r.results[0].ok).toBe(true);
    expect(written.get(file)).toBe(`{ "${SETTING}": true }`);
  });

  it('inserts into a commented file, leaving every comment untouched', () => {
    const before = `{
    // Editor look and feel.
    "editor.fontSize": 14,
    /* Trailing comma is fine in VS Code. */
    "files.autoSave": "off",
}`;
    const { seams, written } = fakeIo([target('Code', file)], { [file]: before });
    const r = enableCopilotTracing([file], fakeSettings(), sourceOn, seams);
    expect(r.results[0].ok).toBe(true);
    // The output is the input with exactly one line added — comments and even
    // the file's trailing-comma style survive.
    expect(written.get(file)).toBe(`{
    // Editor look and feel.
    "editor.fontSize": 14,
    /* Trailing comma is fine in VS Code. */
    "files.autoSave": "off",
    "${SETTING}": true,
}`);
  });

  it('reports an already-enabled file as ok without writing', () => {
    const { seams, written } = fakeIo([target('Code', file)], {
      [file]: `{ "${SETTING}": true }`,
    });
    const r = enableCopilotTracing([file], fakeSettings(), sourceOn, seams);
    expect(r.results[0]).toEqual({
      settingsFile: file,
      ok: true,
      detail: 'Tracing was already switched on.',
    });
    expect(written.size).toBe(0);
  });

  it('refuses a path that is not a known target', () => {
    const { seams, written } = fakeIo([target('Code', file)], {});
    const r = enableCopilotTracing(['C:/anywhere/else.json'], fakeSettings(), sourceOn, seams);
    expect(r.results[0].ok).toBe(false);
    expect(r.results[0].detail).toBe('Not a known editor settings file.');
    expect(written.size).toBe(0);
  });

  it('refuses an unparseable file rather than clobbering it', () => {
    const { seams, written } = fakeIo([target('Code', file)], { [file]: '{ broken' });
    const r = enableCopilotTracing([file], fakeSettings(), sourceOn, seams);
    expect(r.results[0].ok).toBe(false);
    expect(written.size).toBe(0);
  });

  it('a failed write on one target does not stop the others', () => {
    const other = 'Cursor/User/settings.json';
    const { seams, written } = fakeIo(
      [target('Code', file), target('Cursor', other)],
      { [file]: '{}', [other]: '{}' },
      { deniedWrites: [file] },
    );
    const r = enableCopilotTracing([file, other], fakeSettings(), sourceOn, seams);
    expect(r.results.map((x) => x.ok)).toEqual([false, true]);
    expect(r.results[0].detail).toContain('EACCES');
    expect(written.has(other)).toBe(true);
  });
});

describe('startupCopilotSetup', () => {
  const file = 'Code/User/settings.json';

  it('prompt mode computes status and writes nothing', () => {
    const { seams, written } = fakeIo([target('Code', file)], { [file]: '{}' });
    const r = startupCopilotSetup(fakeSettings(), sourceOn, seams);
    expect(written.size).toBe(0);
    expect(r.status.shouldPrompt).toBe(true);
    expect(r.notes).toEqual([
      'Copilot: tracing is switched off in VS Code — enable it in Settings',
    ]);
  });

  it('says nothing when an editor already traces', () => {
    const { seams } = fakeIo([target('Code', file)], { [file]: `{ "${SETTING}": true }` });
    const r = startupCopilotSetup(fakeSettings(), sourceOn, seams);
    expect(r.notes).toEqual([]);
    expect(r.status.shouldPrompt).toBe(false);
  });

  it('says nothing when the Copilot source is off in this app', () => {
    const { seams, written } = fakeIo([target('Code', file)], { [file]: '{}' });
    const r = startupCopilotSetup(
      fakeSettings({ [COPILOT_SETUP_AUTO_APPLY_KEY]: true }),
      sourceOff,
      seams,
    );
    expect(written.size).toBe(0);
    expect(r.notes).toEqual([]);
  });

  it('a persisted dismissal suppresses the prompt but keeps the advisory note', () => {
    const { seams } = fakeIo([target('Code', file)], { [file]: '{}' });
    const r = startupCopilotSetup(fakeSettings({ [COPILOT_SETUP_DISMISS_KEY]: true }), sourceOn, seams);
    expect(r.status.shouldPrompt).toBe(false);
    expect(r.notes.length).toBe(1);
  });

  it('silent mode fixes unset and missing-file targets, never an explicit false', () => {
    const missing = 'Cursor/User/settings.json';
    const off = 'VSCodium/User/settings.json';
    const { seams, written } = fakeIo(
      [target('Code', file), target('Cursor', missing), target('VSCodium', off)],
      { [file]: '{}', [off]: `{ "${SETTING}": false }` },
    );
    const r = startupCopilotSetup(
      fakeSettings({ [COPILOT_SETUP_AUTO_APPLY_KEY]: true }),
      sourceOn,
      seams,
    );
    expect([...written.keys()].sort()).toEqual([file, missing]);
    expect(written.has(off)).toBe(false);
    expect(r.notes).toEqual([
      'Copilot: tracing was switched on — restart VS Code to start recording',
    ]);
    expect(r.status.targets.map((t) => t.state)).toEqual(['enabled', 'enabled', 'disabled']);
  });
});
