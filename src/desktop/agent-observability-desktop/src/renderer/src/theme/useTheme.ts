import { useCallback, useEffect, useState } from 'react';

/**
 * The app's light/dark preference.
 *
 * Dark is the default — this is a tool that sits open next to an editor, and
 * most people running it are in a dark editor already. The choice is explicit
 * rather than following the OS, because a session view that flips theme when
 * the system switches at sunset is more disruptive than helpful.
 *
 * The value is applied as `data-theme` on the document element so CSS can key
 * off it, and persisted so a restart keeps the choice. Persistence is
 * best-effort: a browser context with storage disabled still works, it just
 * starts dark each time.
 */

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'agent-observability.theme';
const DEFAULT_THEME: Theme = 'dark';

function readStored(): Theme {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function persist(theme: Theme): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Storage unavailable; the theme still applies for this run.
  }
}

/** Apply immediately at module load so the first paint is already themed. */
export function applyStoredThemeEarly(): void {
  document.documentElement.dataset.theme = readStored();
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(readStored);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    persist(theme);
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'));
  }, []);

  return { theme, toggle };
}
