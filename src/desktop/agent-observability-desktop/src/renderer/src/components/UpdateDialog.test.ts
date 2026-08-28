import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UpdateDialogView } from './UpdateDialog';
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
