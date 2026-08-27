import { useEffect, useState } from 'react';

/**
 * Follows the OS light/dark setting, and keeps following it when it changes.
 *
 * The app's own styles handle this in CSS, but the embedded detail document is
 * generated ahead of time and needs to be told which palette to use.
 */
export function useTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  );

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent): void => setTheme(event.matches ? 'dark' : 'light');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return theme;
}
