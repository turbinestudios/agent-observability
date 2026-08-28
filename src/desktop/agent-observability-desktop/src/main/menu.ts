import { Menu } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';

/**
 * The application menu.
 *
 * Electron installs a default menu when none is set, and that default carries
 * **Toggle Developer Tools** — a debugging affordance in a shipped app, one
 * keystroke from a window most people cannot interpret. Setting a menu here is
 * the only way to drop a single item from it: the default template is not
 * exposed, so it has to be restated.
 *
 * Everything else is Electron's default, expressed through the same composite
 * roles it uses, so the File/Edit/Window menus keep their platform-correct
 * labels, accelerators, and macOS-only entries without being spelled out.
 *
 * Renderer console output is still reachable without devtools: `AO_DEBUG=1`
 * forwards it to stdout (see `index.ts`).
 */
export function installApplicationMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(process.platform)));
}

/**
 * The template itself, split out so a test can hold the one property that
 * matters — that no menu opens the developer tools — without an Electron
 * runtime to build a real menu in.
 */
export function buildMenuTemplate(platform: NodeJS.Platform): MenuItemConstructorOptions[] {
  const isMac = platform === 'darwin';

  return [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      // The default View menu, minus Toggle Developer Tools. Reload stays: it
      // recovers a wedged window without restarting the app.
      label: '&View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
}
