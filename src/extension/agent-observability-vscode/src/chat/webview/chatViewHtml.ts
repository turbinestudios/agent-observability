import { escapeHtml } from '@agent-observability/core/src/views/escapeHtml';
import { QUICK_COMMANDS } from '@agent-observability/core/src/chat/quickCommands';

/**
 * Pure HTML for the AI Helper webview, following the established pattern in
 * `views/sessionDetailHtml.ts`: inline CSS (`--vscode-*` theming), a strict
 * per-render CSP with a nonce, and an inline `<script>` that talks to the host
 * via `acquireVsCodeApi()`. No framework, no bundler, no external resources.
 *
 * The script is intentionally template-literal-free (string concatenation + DOM
 * APIs only) so it can live inside this module's template literal unescaped, and
 * so assistant content is assigned via host-rendered, already-sanitized HTML
 * (see `markdownToHtml.ts`) rather than built from model text in the webview.
 */

/** Render the full webview document for the given per-render CSP nonce. */
export function renderChatHtml(nonce: string): string {
  const buttons = QUICK_COMMANDS.map(
    (c) =>
      `<button class="qc" data-cmd="${escapeHtml(c.id)}">` +
      `<span class="qc-label">${escapeHtml(c.label)}</span>` +
      `<span class="qc-desc">${escapeHtml(c.description)}</span></button>`,
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src 'none'; font-src 'none';" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
  <div id="empty">
    <p class="intro">Ask about your local agent telemetry, or pick a task. Answers use the backend selected below (GitHub Copilot or Claude Code) under your own license.</p>
    <div class="qc-list">${buttons}</div>
  </div>
  <div id="messages" class="hidden" aria-live="polite"></div>
  <div id="prefs">
    <select id="backendSel" aria-label="AI backend"></select>
    <select id="modelSel" aria-label="Model"></select>
    <select id="effortSel" class="hidden" aria-label="Reasoning effort"></select>
  </div>
  <div id="inputRow">
    <textarea id="input" rows="1" placeholder="Type a message…" aria-label="Message"></textarea>
    <button id="send" title="Send">Send</button>
    <button id="stop" class="hidden" title="Stop">Stop</button>
  </div>
  <script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}

const STYLE = `
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background);
  display: flex;
  flex-direction: column;
  height: 100vh;
}
.hidden { display: none !important; }
#empty { padding: 12px; overflow-y: auto; }
.intro { color: var(--vscode-descriptionForeground); margin: 4px 0 12px; }
.qc-list { display: flex; flex-direction: column; gap: 8px; }
.qc {
  display: flex; flex-direction: column; gap: 2px; text-align: left;
  padding: 10px 12px; cursor: pointer;
  color: var(--vscode-foreground);
  background: var(--vscode-button-secondaryBackground, var(--vscode-editorWidget-background));
  border: 1px solid var(--vscode-widget-border, transparent);
  border-radius: 6px;
}
.qc:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
.qc-label { font-weight: 600; }
.qc-desc { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
#messages { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 12px; }
.msg { display: flex; }
.msg.user { justify-content: flex-end; }
.bubble {
  max-width: 92%; padding: 8px 12px; border-radius: 8px; line-height: 1.45;
  overflow-wrap: anywhere; white-space: normal;
}
.msg.user .bubble { background: var(--vscode-textBlockQuote-background); border: 1px solid var(--vscode-widget-border, transparent); white-space: pre-wrap; }
.msg.assistant .bubble { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, transparent); }
.msg.error .bubble { background: var(--vscode-inputValidation-errorBackground, rgba(255,0,0,0.1)); border: 1px solid var(--vscode-inputValidation-errorBorder, red); }
.msg.system .bubble { background: transparent; color: var(--vscode-descriptionForeground); font-size: 0.9em; padding: 2px 4px; }
.bubble p { margin: 0 0 8px; }
.bubble p:last-child { margin-bottom: 0; }
.bubble h1, .bubble h2, .bubble h3, .bubble h4 { margin: 8px 0 4px; }
.bubble ul, .bubble ol { margin: 4px 0; padding-left: 20px; }
.bubble code { font-family: var(--vscode-editor-font-family, monospace); background: var(--vscode-textCodeBlock-background); padding: 0 3px; border-radius: 3px; }
.code-block { position: relative; margin: 8px 0; border: 1px solid var(--vscode-widget-border, transparent); border-radius: 6px; overflow: hidden; }
.code-block pre { margin: 0; padding: 10px; overflow-x: auto; background: var(--vscode-textCodeBlock-background); }
.code-block pre code { background: transparent; padding: 0; }
.code-toolbar { display: flex; gap: 6px; justify-content: flex-end; padding: 4px 6px; background: var(--vscode-editorWidget-background); border-bottom: 1px solid var(--vscode-widget-border, transparent); }
.mini-btn { font-size: 0.85em; padding: 2px 8px; cursor: pointer; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: none; border-radius: 4px; }
.mini-btn.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
.mini-btn:hover { filter: brightness(1.1); }
#prefs { display: flex; gap: 6px; padding: 6px 8px 0; border-top: 1px solid var(--vscode-widget-border, transparent); }
#prefs select {
  flex: 1; min-width: 0; padding: 2px 4px; font-family: inherit; font-size: 0.9em;
  color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background);
  border: 1px solid var(--vscode-dropdown-border, var(--vscode-widget-border, transparent)); border-radius: 4px;
}
#inputRow { display: flex; gap: 6px; padding: 8px; align-items: flex-end; }
#input {
  flex: 1; resize: none; max-height: 140px; padding: 6px 8px;
  font-family: inherit; font-size: inherit;
  color: var(--vscode-input-foreground); background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent)); border-radius: 4px;
}
#send, #stop { padding: 6px 12px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; border-radius: 4px; }
#send:hover, #stop:hover { background: var(--vscode-button-hoverBackground); }
`;

const SCRIPT = `
(function () {
  var vscode = acquireVsCodeApi();
  var empty = document.getElementById('empty');
  var messages = document.getElementById('messages');
  var input = document.getElementById('input');
  var sendBtn = document.getElementById('send');
  var stopBtn = document.getElementById('stop');
  var bubbles = {};

  function post(msg) { vscode.postMessage(msg); }
  function showConversation() { empty.classList.add('hidden'); messages.classList.remove('hidden'); }
  function scrollDown() { messages.scrollTop = messages.scrollHeight; }

  function addMessage(cls) {
    showConversation();
    var wrap = document.createElement('div');
    wrap.className = 'msg ' + cls;
    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    wrap.appendChild(bubble);
    messages.appendChild(wrap);
    scrollDown();
    return bubble;
  }

  function enhanceCodeBlocks(bubble) {
    var blocks = bubble.querySelectorAll('.code-block');
    for (var i = 0; i < blocks.length; i++) {
      var el = blocks[i];
      if (el.getAttribute('data-enhanced')) continue;
      el.setAttribute('data-enhanced', '1');
      var lang = el.getAttribute('data-lang') || '';
      var codeEl = el.querySelector('code');
      var code = codeEl ? codeEl.textContent : '';
      var bar = document.createElement('div');
      bar.className = 'code-toolbar';
      var copyBtn = document.createElement('button');
      copyBtn.className = 'mini-btn';
      copyBtn.textContent = 'Copy';
      (function (text) { copyBtn.addEventListener('click', function () { post({ type: 'copy', text: text }); }); })(code);
      bar.appendChild(copyBtn);
      if (lang === 'ao-workflows' || lang === 'ao-config') {
        var applyBtn = document.createElement('button');
        applyBtn.className = 'mini-btn primary';
        applyBtn.textContent = 'Apply to settings.json';
        (function (text, kind) { applyBtn.addEventListener('click', function () { post({ type: 'applyConfig', kind: kind, code: text }); }); })(code, lang === 'ao-workflows' ? 'workflows' : 'config');
        bar.appendChild(applyBtn);
      }
      el.insertBefore(bar, el.firstChild);
    }
  }

  function setBusy(busy) {
    sendBtn.classList.toggle('hidden', busy);
    stopBtn.classList.toggle('hidden', !busy);
    input.disabled = busy;
  }

  function submit() {
    var text = input.value.trim();
    if (text.length === 0) return;
    input.value = '';
    post({ type: 'send', text: text });
  }

  sendBtn.addEventListener('click', submit);
  stopBtn.addEventListener('click', function () { post({ type: 'stop' }); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  });

  var qcs = document.querySelectorAll('.qc');
  for (var j = 0; j < qcs.length; j++) {
    qcs[j].addEventListener('click', function () { post({ type: 'runQuickCommand', id: this.getAttribute('data-cmd') }); });
  }

  var backendSel = document.getElementById('backendSel');
  var modelSel = document.getElementById('modelSel');
  var effortSel = document.getElementById('effortSel');
  var rebuildingPrefs = false;

  function fillSelect(sel, options, active) {
    sel.innerHTML = '';
    for (var k = 0; k < options.length; k++) {
      var opt = document.createElement('option');
      opt.value = options[k].value;
      opt.textContent = options[k].text;
      if (options[k].disabled) opt.disabled = true;
      if (options[k].value === active) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  function applyUiState(state) {
    rebuildingPrefs = true;
    var backendOpts = [];
    for (var b = 0; b < state.backends.length; b++) {
      var be = state.backends[b];
      backendOpts.push({
        value: be.id,
        text: be.available || !be.hint ? be.label : be.label + ' — ' + be.hint,
        disabled: !be.available && be.id !== state.activeBackend
      });
    }
    fillSelect(backendSel, backendOpts, state.activeBackend);

    var modelOpts = [];
    if (state.activeBackend === 'copilot') {
      modelOpts.push({ value: '', text: 'Auto (first available)' });
    }
    for (var m = 0; m < state.models.length; m++) {
      modelOpts.push({ value: state.models[m].id, text: state.models[m].label });
    }
    fillSelect(modelSel, modelOpts, state.activeModel);

    if (state.efforts) {
      var effortOpts = [];
      for (var e = 0; e < state.efforts.length; e++) {
        effortOpts.push({ value: state.efforts[e], text: 'Effort: ' + state.efforts[e] });
      }
      fillSelect(effortSel, effortOpts, state.activeEffort);
      effortSel.classList.remove('hidden');
    } else {
      effortSel.classList.add('hidden');
    }
    rebuildingPrefs = false;
  }

  function onPrefChange(key, sel) {
    sel.addEventListener('change', function () {
      if (rebuildingPrefs) return;
      post({ type: 'setPreference', key: key, value: sel.value });
    });
  }
  onPrefChange('backend', backendSel);
  onPrefChange('model', modelSel);
  onPrefChange('effort', effortSel);

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'busy') { setBusy(!!msg.busy); return; }
    if (msg.type === 'userEcho') { addMessage('user').textContent = msg.text; return; }
    if (msg.type === 'assistantStart') { bubbles[msg.id] = addMessage('assistant'); return; }
    if (msg.type === 'assistantHtml') { var ab = bubbles[msg.id]; if (ab) { ab.innerHTML = msg.html; scrollDown(); } return; }
    if (msg.type === 'assistantDone') { var db = bubbles[msg.id]; if (db) enhanceCodeBlocks(db); return; }
    if (msg.type === 'error') { addMessage('error').textContent = msg.message; return; }
    if (msg.type === 'applied') { addMessage(msg.ok ? 'system' : 'error').textContent = msg.message; return; }
    if (msg.type === 'reset') { messages.innerHTML = ''; bubbles = {}; messages.classList.add('hidden'); empty.classList.remove('hidden'); return; }
    if (msg.type === 'uiState') { applyUiState(msg.state); return; }
  });

  post({ type: 'ready' });
})();
`;
