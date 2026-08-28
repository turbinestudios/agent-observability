import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UpdateIndicator } from './UpdateIndicator';
import { downloadingStatus } from '../../../shared/updates';

const render = (status: Parameters<typeof UpdateIndicator>[0]['status']): string =>
  renderToStaticMarkup(createElement(UpdateIndicator, { status }));

describe('UpdateIndicator', () => {
  it('draws the bar at the reported width and labels it for a screen reader', () => {
    const html = render(
      downloadingStatus('1.2.0', {
        percent: 42,
        transferred: 42,
        total: 100,
        bytesPerSecond: 10,
      }),
    );

    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="42"');
    expect(html).toContain('width:42%');
    expect(html).toContain('42%');
  });

  it('never emits a NaN width, which would render as an invisible bar', () => {
    const html = render(
      downloadingStatus('1.2.0', {
        percent: Number.NaN,
        transferred: 0,
        total: 0,
        bytesPerSecond: 0,
      }),
    );

    expect(html).not.toContain('NaN');
    expect(html).toContain('width:0%');
  });

  it('reports the finished and failed states in words, not a bar', () => {
    const done = render({ phase: 'downloaded', version: '1.2.0' });
    expect(done).toContain('Ready');
    expect(done).not.toContain('progressbar');

    const failed = render({ phase: 'failed', message: 'socket hang up' });
    expect(failed).toContain('Failed');
    expect(failed).toContain('socket hang up');
  });
});
