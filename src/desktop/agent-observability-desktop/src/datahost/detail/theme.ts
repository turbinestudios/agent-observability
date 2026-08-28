/**
 * Bridges the shared session renderer into this app's look.
 *
 * That renderer styles itself with VS Code's theme variables, which is exactly
 * right inside the extension and means nothing here. Rather than fork 2,200
 * lines of rendering to change some colors, we define the variables it reads.
 * The document then themes itself, and improvements to it reach both hosts.
 *
 * Every variable the renderer actually uses is covered; a missing one would
 * fall back to `initial` and render as invisible or unstyled text.
 */

/** The two palettes, keyed by the VS Code variable each value fills in. */
const LIGHT: Record<string, string> = {
  'vscode-font-family': `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Ubuntu, sans-serif`,
  'vscode-font-size': '13px',
  'vscode-editor-font-family': `ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace`,
  'vscode-foreground': '#1c1e21',
  'vscode-descriptionForeground': '#62676d',
  'vscode-editor-background': '#ffffff',
  'vscode-editorWidget-background': '#f6f7f9',
  'vscode-editorWidget-border': '#d9dce0',
  'vscode-panel-border': '#d9dce0',
  'vscode-focusBorder': '#2f6fd0',
  'vscode-list-hoverBackground': '#eef1f5',
  'vscode-input-background': '#ffffff',
  'vscode-badge-background': '#e3e6ea',
  'vscode-badge-foreground': '#31353a',
  'vscode-button-secondaryBackground': '#e6e9ed',
  'vscode-button-secondaryForeground': '#1c1e21',
  'vscode-button-secondaryHoverBackground': '#dadee3',
  'vscode-textCodeBlock-background': '#f2f4f6',
  'vscode-textBlockQuote-background': '#f4f6f8',
  'vscode-textBlockQuote-border': '#c8cdd3',
  'vscode-textLink-foreground': '#2f6fd0',
  'vscode-textLink-activeForeground': '#1f52a0',
  'vscode-editorWarning-foreground': '#9a6400',
  'vscode-errorForeground': '#c23934',
  'vscode-widget-border': '#d9dce0',
  'vscode-button-background': '#2f6fd0',
  'vscode-button-foreground': '#ffffff',
  'vscode-inputValidation-infoBackground': '#e8f0fb',
  'vscode-inputValidation-infoBorder': '#a8c4e8',
  'vscode-inputValidation-infoForeground': '#1c1e21',
  'vscode-inputValidation-warningBackground': '#fdf3e0',
  'vscode-testing-iconPassed': '#2f8a4c',
  'vscode-testing-iconFailed': '#c23934',
  // Categorical series. Hues stay distinguishable in both themes and do not
  // rely on brightness alone to separate.
  'vscode-charts-blue': '#3573c4',
  'vscode-charts-green': '#2f8a4c',
  'vscode-charts-orange': '#c9721f',
  'vscode-charts-purple': '#7a52c7',
  'vscode-charts-red': '#c23934',
  'vscode-charts-yellow': '#b58900',
};

const DARK: Record<string, string> = {
  ...LIGHT,
  'vscode-foreground': '#e6e8ea',
  'vscode-descriptionForeground': '#a0a6ad',
  'vscode-editor-background': '#16171a',
  'vscode-editorWidget-background': '#1e2024',
  'vscode-editorWidget-border': '#2c2f34',
  'vscode-panel-border': '#2c2f34',
  'vscode-focusBorder': '#5b9bf8',
  'vscode-list-hoverBackground': '#23262b',
  'vscode-input-background': '#1b1d21',
  'vscode-badge-background': '#2e3238',
  'vscode-badge-foreground': '#dfe3e7',
  'vscode-button-secondaryBackground': '#2a2e34',
  'vscode-button-secondaryForeground': '#e6e8ea',
  'vscode-button-secondaryHoverBackground': '#343941',
  'vscode-textCodeBlock-background': '#1b1e22',
  'vscode-textBlockQuote-background': '#1b1e22',
  'vscode-textBlockQuote-border': '#3d4147',
  'vscode-textLink-foreground': '#5b9bf8',
  'vscode-textLink-activeForeground': '#87b7ff',
  'vscode-editorWarning-foreground': '#d0a215',
  'vscode-errorForeground': '#e5534b',
  'vscode-widget-border': '#2c2f34',
  'vscode-button-background': '#3c6fc4',
  'vscode-button-foreground': '#ffffff',
  'vscode-inputValidation-infoBackground': '#1c2942',
  'vscode-inputValidation-infoBorder': '#2f4c78',
  'vscode-inputValidation-infoForeground': '#e6e8ea',
  'vscode-inputValidation-warningBackground': '#33290f',
  'vscode-testing-iconPassed': '#5cc47c',
  'vscode-testing-iconFailed': '#f0736a',
  'vscode-charts-blue': '#5b9bf8',
  'vscode-charts-green': '#5cc47c',
  'vscode-charts-orange': '#e8a253',
  'vscode-charts-purple': '#b18df0',
  'vscode-charts-red': '#f0736a',
  'vscode-charts-yellow': '#e3c14a',
};

function block(selector: string, values: Record<string, string>): string {
  const lines = Object.entries(values)
    .map(([name, value]) => `  --${name}: ${value};`)
    .join('\n');
  return `${selector} {\n${lines}\n}`;
}

/**
 * A `<style>` element defining every variable the renderer reads, plus the
 * shim it needs to run outside VS Code.
 *
 * The nonce must be the one passed to the renderer, since the document's CSP
 * allows styles and scripts only by nonce.
 *
 * `acquireVsCodeApi` is called unconditionally by the renderer's controller
 * script, so without a stand-in the document throws before it can wire up its
 * own interactions. Messages are forwarded to the parent frame, which routes
 * them to the data host.
 */
export function detailHeadHtml(nonce: string, theme: 'light' | 'dark'): string {
  const palette = theme === 'dark' ? DARK : LIGHT;
  return `<style nonce="${nonce}">
${block(':root', palette)}
html, body { background: var(--vscode-editor-background); }
</style>
<script nonce="${nonce}">
window.acquireVsCodeApi = function () {
  var state = {};
  return {
    postMessage: function (message) { parent.postMessage({ __aoDetail: message }, '*'); },
    getState: function () { return state; },
    setState: function (next) { state = next; return next; }
  };
};
</script>`;
}
