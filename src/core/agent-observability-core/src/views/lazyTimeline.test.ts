import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import {
  renderCombinedSessionDetailContent, renderCombinedSessionDetailHtml,
  renderSessionDetailContent, renderSessionDetailHtml, renderTimelineRow, TIMELINE_PAGE_SIZE,
} from './sessionDetailHtml';
import type { SessionDetail, SessionTurn } from '../telemetry/models';
import { combineSessionDetails } from '../telemetry/combinedSessionDetail';

function turn(count: number): SessionTurn {
  return {
    timestampMs: 1_000, agentMode: 'agent', model: 'model-test', durationMs: 1_000,
    success: true, userRequest: 'Synthetic prompt', finalResponse: 'Synthetic answer',
    llmCalls: 1, inputTokens: 10, outputTokens: 5, cachedTokens: 0, reasoningTokens: 0,
    linesOfCode: 0, linesOfDoc: 0, linesOfCodeRemoved: 0, linesOfDocRemoved: 0,
    events: Array.from({ length: count }, (_, i) => ({
      timestampMs: 1_000 + i, operation: 'execute_tool', agentMode: 'agent', model: 'model-test',
      toolName: `tool-${i}`, durationMs: 10, success: i % 2 === 0,
      userRequest: 'Event content that is not displayed must not enter the payload',
    })),
  };
}

function detail(count: number, sessionId = 'synthetic'): SessionDetail {
  return {
    summary: {
      sessionId, repository: 'unknown', startedAtMs: 1_000, endedAtMs: 2_000, durationMs: 1_000,
      interactionCount: count, llmCalls: 1, toolCalls: count, inputTokens: 10,
      outputTokens: 5, cachedTokens: 0, model: 'model-test', agentModes: ['agent'],
    },
    treeStats: {
      modelTurns: 1, toolCalls: count, inputTokens: 10, outputTokens: 5,
      cachedTokens: 0, totalTokens: 15, errorCount: 0, aiuNano: 0,
      linesOfCode: 0, linesOfDoc: 0, linesOfCodeRemoved: 0, linesOfDocRemoved: 0,
    },
    turns: [turn(count)], modelUsage: [], agentUsage: [], treeModelTurns: [],
  };
}

const open: JSDOM[] = [];
afterEach(() => { for (const dom of open.splice(0)) { dom.window.close(); } });

function mount(html: string) {
  const errors: Error[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (error) => errors.push(error));
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', virtualConsole,
    beforeParse: (window) => {
      window.acquireVsCodeApi = () => ({ postMessage: vi.fn() });
      window.scrollTo = vi.fn();
    },
  });
  open.push(dom);
  return { dom, doc: dom.window.document, errors };
}

function expand(dom: JSDOM, selector = 'details[data-lazy-timeline]') {
  const node = dom.window.document.querySelector<HTMLDetailsElement>(selector)!;
  node.open = true;
  node.dispatchEvent(new dom.window.Event('toggle'));
  return node;
}

describe('lazy event timelines', () => {
  it('keeps 10,000 events available without initially constructing their rows', () => {
    const data = detail(10_000);
    const html = renderSessionDetailHtml(data, [], 'nonce');
    const { doc, errors } = mount(html);
    expect(doc.querySelectorAll('.timeline .row')).toHaveLength(0);
    const payload = doc.querySelector<HTMLTemplateElement>('.timeline-data')!;
    expect(JSON.parse(payload.content.textContent!)).toHaveLength(10_000);
    expect(html).not.toContain('Event content that is not displayed');
    expect(html.length).toBeLessThan(renderTimelineRow(data.turns[0].events[0]).length * 10_000);
    expect(doc.querySelector('.timeline-disclosure summary')?.textContent).toContain('10000 event(s)');
    expect(errors).toEqual([]);
  }, 30_000);

  it('materializes at most one page and reaches the final event without duplicates', () => {
    const { dom, doc, errors } = mount(renderSessionDetailHtml(detail(205), [], 'nonce'));
    const timeline = expand(dom);
    expect(doc.querySelectorAll('.timeline .row')).toHaveLength(TIMELINE_PAGE_SIZE);
    const next = timeline.querySelector<HTMLButtonElement>('.timeline-next')!;
    const prev = timeline.querySelector<HTMLButtonElement>('.timeline-prev')!;
    expect(prev.disabled).toBe(true);
    next.click();
    expect(timeline.querySelector('.target')?.textContent).toBe('tool-100');
    expect(doc.querySelectorAll('.timeline .row')).toHaveLength(100);
    next.click();
    expect(doc.querySelectorAll('.timeline .row')).toHaveLength(5);
    expect(timeline.querySelector('.timeline-page-status')?.textContent).toBe('Events 201–205 of 205');
    expect(timeline.querySelectorAll('.target')[4].textContent).toBe('tool-204');
    expect(next.disabled).toBe(true);
    prev.click();
    expect(timeline.querySelector('.target')?.textContent).toBe('tool-100');
    timeline.open = false;
    timeline.dispatchEvent(new dom.window.Event('toggle'));
    expect(doc.querySelectorAll('.timeline .row')).toHaveLength(0);
    expand(dom);
    expect(timeline.querySelector('.target')?.textContent).toBe('tool-100');
    expect(errors).toEqual([]);
  });

  it('preserves page/open/tab/scroll across updates and clamps pages when data shrinks', () => {
    const { dom, doc, errors } = mount(renderSessionDetailHtml(detail(205), [], 'nonce'));
    // Use real navigation elements without needing unrelated context fixtures.
    doc.getElementById('live-root')!.insertAdjacentHTML('afterbegin', '<nav><button class="tab-btn tab-btn-active" data-tab="test-tab">Context</button></nav><div id="test-tab" class="tab-panel"></div>');
    const timeline = expand(dom);
    timeline.querySelector<HTMLButtonElement>('.timeline-next')!.click();
    timeline.querySelector<HTMLButtonElement>('.timeline-next')!.click();
    const update = (count: number) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'update', html: '<nav><button class="tab-btn" data-tab="test-tab">Context</button></nav><div id="test-tab" class="tab-panel tab-panel-hidden"></div>' + renderSessionDetailContent(detail(count), []) },
    }));
    update(250);
    let current = doc.querySelector<HTMLDetailsElement>('details[data-lazy-timeline]')!;
    expect(current.open).toBe(true);
    expect(current.querySelector('.target')?.textContent).toBe('tool-200');
    expect(doc.querySelector('.tab-btn-active')?.getAttribute('data-tab')).toBe('test-tab');
    expect(dom.window.scrollTo).toHaveBeenCalled();
    update(150);
    current = doc.querySelector<HTMLDetailsElement>('details[data-lazy-timeline]')!;
    expect(current.querySelector('.timeline-page-status')?.textContent).toBe('Events 101–150 of 150');
    expect(errors).toEqual([]);
  });

  it('escapes template delimiters and uses text-only event construction', () => {
    const data = detail(101);
    const attack = '</template><script>window.pwned=1</script><img src=x onerror="window.pwned=2">&"';
    data.turns[0].events[0].toolName = attack;
    const { dom, doc, errors } = mount(renderSessionDetailHtml(data, [], 'nonce'));
    expect(doc.querySelectorAll('script')).toHaveLength(1);
    expect(doc.querySelectorAll('img')).toHaveLength(0);
    expand(dom);
    expect(doc.querySelector('.timeline .target')?.textContent).toBe(attack);
    expect(doc.querySelectorAll('script')).toHaveLength(1);
    expect(doc.querySelectorAll('img')).toHaveLength(0);
    expect(dom.window.pwned).toBeUndefined();
    expect(errors).toEqual([]);
  });

  it('defers many small turn timelines when the whole session is large', () => {
    const data = detail(0);
    data.turns = Array.from({ length: 20 }, () => turn(10));
    const { dom, doc } = mount(renderSessionDetailHtml(data, [], 'nonce'));
    expect(doc.querySelectorAll('.timeline .row')).toHaveLength(0);
    expect(doc.querySelectorAll('details[data-lazy-timeline]')).toHaveLength(20);
    expand(dom);
    expect(doc.querySelectorAll('.timeline .row')).toHaveLength(10);
  });

  it('retains the eager presentation for small and empty sessions', () => {
    const { doc } = mount(renderSessionDetailHtml(detail(3), [], 'nonce'));
    expect(doc.querySelectorAll('.timeline .row')).toHaveLength(3);
    expect(doc.querySelectorAll('.timeline-data')).toHaveLength(0);
    expect(renderSessionDetailContent(detail(0), [])).not.toContain('data-lazy-timeline');
  });

  it('formats deferred values identically to eager rows for the current locale', () => {
    const data = detail(101);
    const expected = new JSDOM(renderTimelineRow(data.turns[0].events[0]));
    open.push(expected);
    const { dom, doc } = mount(renderSessionDetailHtml(data, [], 'nonce'));
    expand(dom);
    for (const selector of ['.time', '.op', '.mode', '.target', '.dur', '.status']) {
      expect(doc.querySelector('.timeline ' + selector)?.textContent)
        .toBe(expected.window.document.querySelector(selector)?.textContent);
    }
  });

  it('contains malformed lazy data without breaking the document controller', () => {
    const html = renderSessionDetailHtml(detail(101), [], 'nonce')
      .replace(/(<template class="timeline-data">)[\s\S]*?(<\/template>)/, '$1broken-json$2');
    const { dom, doc, errors } = mount(html);
    expand(dom);
    expect(doc.querySelector('.timeline-page-status')?.textContent).toBe('Timeline data unavailable.');
    expect(doc.querySelector<HTMLButtonElement>('.timeline-next')?.disabled).toBe(true);
    expect(errors).toEqual([]);
  });

  it('keeps pages independent for combined sessions and restores both on update', () => {
    const details = [detail(205, 'a'), detail(205, 'b')];
    const view = { combined: combineSessionDetails(details), sections: details.map((d) => ({ detail: d, turnDeviations: [] })) };
    const { dom, doc, errors } = mount(renderCombinedSessionDetailHtml(view, 'nonce'));
    const first = expand(dom, '[data-k="s0t0l"]');
    first.querySelector<HTMLButtonElement>('.timeline-next')!.click();
    expand(dom, '[data-k="s1t0l"]');
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'update', html: renderCombinedSessionDetailContent(view) },
    }));
    expect(doc.querySelector('[data-k="s0t0l"] .target')?.textContent).toBe('tool-100');
    expect(doc.querySelector('[data-k="s1t0l"] .target')?.textContent).toBe('tool-0');
    expect(doc.querySelectorAll('.timeline .row')).toHaveLength(200);
    expect(errors).toEqual([]);
  });
});