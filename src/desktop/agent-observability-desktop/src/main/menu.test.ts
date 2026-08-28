import { describe, it, expect } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { buildMenuTemplate } from './menu';

/**
 * The menu exists for one reason: Electron's default carries Toggle Developer
 * Tools, which is a debugging affordance in a shipped app. Restating the
 * default to drop one item is easy to undo by accident — someone deleting this
 * module gets the devtools item back and nothing complains — so the absence is
 * asserted rather than assumed.
 */

/** Every role in the template, however deeply nested. */
function roles(items: readonly MenuItemConstructorOptions[]): string[] {
  return items.flatMap((item) => [
    ...(item.role === undefined ? [] : [item.role]),
    ...(Array.isArray(item.submenu) ? roles(item.submenu) : []),
  ]);
}

describe('buildMenuTemplate', () => {
  it('opens the developer tools from nowhere, on any platform', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as NodeJS.Platform[]) {
      expect(roles(buildMenuTemplate(platform))).not.toContain('toggleDevTools');
    }
  });

  it('keeps the rest of the View menu, including reload', () => {
    const view = buildMenuTemplate('win32').find((item) => item.label === '&View');

    // Reload earns its place: it recovers a wedged window without a restart.
    expect(roles(view === undefined ? [] : [view])).toEqual([
      'reload',
      'forceReload',
      'resetZoom',
      'zoomIn',
      'zoomOut',
      'togglefullscreen',
    ]);
  });

  it('keeps the platform-standard menus, so nothing else is lost with it', () => {
    const windows = roles(buildMenuTemplate('win32'));
    expect(windows).toContain('fileMenu');
    expect(windows).toContain('editMenu');
    expect(windows).toContain('windowMenu');
  });

  it('gives macOS its application menu, and no one else', () => {
    expect(roles(buildMenuTemplate('darwin'))).toContain('appMenu');
    expect(roles(buildMenuTemplate('win32'))).not.toContain('appMenu');
    expect(roles(buildMenuTemplate('linux'))).not.toContain('appMenu');
  });
});
