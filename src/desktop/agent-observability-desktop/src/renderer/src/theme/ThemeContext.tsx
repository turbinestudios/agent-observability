import type { JSX, ReactNode } from 'react';
import { createContext, useContext, useMemo } from 'react';
import { useTheme } from './useTheme';
import type { Theme } from './useTheme';

/**
 * Shares the theme with everything that needs it.
 *
 * The app shell themes itself in CSS, but the embedded session document is
 * generated as a complete HTML document with its colors baked in, so it has to
 * be told which palette to render with and re-rendered when that changes.
 */

interface ThemeValue {
  theme: Theme;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeValue>({ theme: 'dark', toggle: () => undefined });

export function ThemeProvider({ children }: { children: ReactNode }): JSX.Element {
  const { theme, toggle } = useTheme();
  const value = useMemo(() => ({ theme, toggle }), [theme, toggle]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useThemeValue(): ThemeValue {
  return useContext(ThemeContext);
}
