/**
 * In-document code, included in the existing nonce-only controller. It reads
 * compact, escaped JSON tuples from inert templates only when a timeline opens.
 * Dynamic values are assigned through textContent, never parsed as markup.
 * root, TIMELINE_PAGE_SIZE, timelineTime and timelineDuration come from the shell.
 */
export const LAZY_TIMELINE_CONTROLLER = `
  function snapshotTimelinePages() {
    var pages = Object.create(null);
    if (root) root.querySelectorAll('details[data-lazy-timeline]').forEach(function(d) {
      pages[d.getAttribute('data-k')] = Number(d.getAttribute('data-page')) || 0;
    });
    return pages;
  }

  function initLazyTimelines(pages) {
    if (!root) return;
    root.querySelectorAll('details[data-lazy-timeline]').forEach(function(d) {
      var list = d.querySelector('.timeline');
      var payload = d.querySelector('template.timeline-data');
      var prev = d.querySelector('.timeline-prev');
      var next = d.querySelector('.timeline-next');
      var label = d.querySelector('.timeline-page-status');
      if (!list || !payload || !prev || !next || !label) return;
      var key = d.getAttribute('data-k');
      var page = pages && Object.prototype.hasOwnProperty.call(pages, key) ? pages[key] : 0;
      var entries;

      function span(parent, css, text) {
        var node = document.createElement('span');
        node.className = css;
        node.textContent = String(text);
        parent.appendChild(node);
        return node;
      }
      function renderPage(requested) {
        if (!entries) {
          try {
            entries = JSON.parse(payload.content.textContent);
            if (!Array.isArray(entries)) throw new Error('Invalid timeline');
            // Do not retain both serialized and parsed copies after opening.
            payload.content.textContent = '';
          } catch (_) {
            entries = [];
            label.textContent = 'Timeline data unavailable.';
            prev.disabled = next.disabled = true;
            return;
          }
        }
        var last = Math.max(0, Math.ceil(entries.length / TIMELINE_PAGE_SIZE) - 1);
        page = Math.max(0, Math.min(last, Number.isFinite(requested) ? Math.floor(requested) : 0));
        d.setAttribute('data-page', String(page));
        var start = page * TIMELINE_PAGE_SIZE;
        var end = Math.min(entries.length, start + TIMELINE_PAGE_SIZE);
        var fragment = document.createDocumentFragment();
        for (var i = start; i < end; i++) {
          var e = entries[i];
          if (!Array.isArray(e) || e.length !== 6) continue;
          var row = document.createElement('div');
          row.className = 'row';
          var main = document.createElement('div');
          main.className = 'row-main';
          row.appendChild(main);
          span(main, 'time', timelineTime(e[0]));
          var op = span(main, 'op', e[1]);
          if (['chat', 'execute_tool', 'execute_hook', 'invoke_agent'].indexOf(e[1]) >= 0) {
            op.classList.add('op-' + e[1]);
          }
          span(main, 'mode', e[2]);
          span(main, 'target', e[3]);
          span(main, 'dur', timelineDuration(e[4]));
          var status = span(main, e[5] ? 'status ok' : 'status fail', e[5] ? '✓' : '✗');
          status.title = e[5] ? 'Success' : 'Failed';
          fragment.appendChild(row);
        }
        list.replaceChildren(fragment);
        label.textContent = 'Events ' + (entries.length ? start + 1 : 0) + '–' + end + ' of ' + entries.length;
        prev.disabled = page === 0;
        next.disabled = page === last;
      }
      prev.addEventListener('click', function() { renderPage(page - 1); });
      next.addEventListener('click', function() { renderPage(page + 1); });
      d.addEventListener('toggle', function() {
        if (d.open) renderPage(page);
        else list.replaceChildren();
      });
      // Restore the selected page even if its disclosure is currently closed.
      d.setAttribute('data-page', String(page));
      if (d.open) renderPage(page);
    });
  }
`;