import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UpdateDialogView, updateDialogState } from './UpdateDialog';
import type { UpdateStatus } from '../../../shared/updates';

/**
 * Rendered to static markup rather than into a DOM, so it stays inside this
 * package's node-only test setup — see vitest.config.ts. The stateless view is
 * tested; the wrapper's subscription needs a window and is exercised manually.
 */

function render(status: Exclude<UpdateStatus, { phase: 'downloaded' }>): string {
  return renderToStaticMarkup(createElement(UpdateDialogView, { status, onDismiss: () => undefined }));
}

describe('UpdateDialogView — downloading', () => {
  const downloading: UpdateStatus = {
    phase: 'downloading',
    version: '1.8.0',
    percent: 42,
    transferred: 12 * 1024 * 1024,
    total: 87 * 1024 * 1024,
    bytesPerSecond: 2.1 * 1024 * 1024,
  };

  it('is a labelled modal dialog with a real progress bar', () => {
    const html = render(downloading);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('Downloading version 1.8.0…');
    expect(html).toContain('aria-valuenow="42"');
    expect(html).toContain('width:42%');
  });

  it('states the size and speed, and offers the background escape hatch', () => {
    const html = render(downloading);
    expect(html).toContain('12 MB of 87 MB, 2.1 MB/s');
    expect(html).toContain('Continue in background');
  });

  it('admits it is still contacting GitHub before the first byte', () => {
    const html = render({
      phase: 'downloading',
      version: '1.8.0',
      percent: 0,
      transferred: 0,
      total: 0,
      bytesPerSecond: 0,
    });
    expect(html).toContain('Contacting GitHub…');
  });
});

describe('UpdateDialogView — failed', () => {
  it('shows the message and reassures that nothing changed', () => {
    const html = render({ phase: 'failed', message: 'net::ERR_INTERNET_DISCONNECTED' });
    expect(html).toContain('The update could not be downloaded');
    expect(html).toContain('net::ERR_INTERNET_DISCONNECTED');
    expect(html).toContain('Nothing changed');
    expect(html).toContain('Close');
  });
});

/**
 * The shell asks this to decide whether the startup overlay must stand down,
 * so "is the dialog up?" and "what does it show?" have to be the same answer.
 */
describe('updateDialogState', () => {
  const downloading: UpdateStatus = {
    phase: 'downloading',
    version: '1.9.0',
    percent: 10,
    transferred: 1,
    total: 2,
    bytesPerSecond: 1,
  };

  it('is absent with no update in flight', () => {
    expect(updateDialogState(undefined, undefined)).toBeUndefined();
  });

  it('is up while downloading, keyed to that version', () => {
    expect(updateDialogState(downloading, undefined)).toEqual({
      status: downloading,
      key: 'download:1.9.0',
    });
  });

  it('stays down once that download is dismissed', () => {
    expect(updateDialogState(downloading, 'download:1.9.0')).toBeUndefined();
  });

  it('opens again for a different version despite the earlier dismissal', () => {
    const next = { ...downloading, version: '1.9.1' } as UpdateStatus;
    expect(updateDialogState(next, 'download:1.9.0')?.key).toBe('download:1.9.1');
  });

  it('renders nothing once downloaded — main takes over with a native prompt', () => {
    expect(updateDialogState({ phase: 'downloaded', version: '1.9.0' }, undefined)).toBeUndefined();
  });

  it('shows a failure, and stays down after it is dismissed', () => {
    const failed: UpdateStatus = { phase: 'failed', message: 'boom' };
    expect(updateDialogState(failed, undefined)).toEqual({ status: failed, key: 'failed' });
    expect(updateDialogState(failed, 'failed')).toBeUndefined();
  });
});
