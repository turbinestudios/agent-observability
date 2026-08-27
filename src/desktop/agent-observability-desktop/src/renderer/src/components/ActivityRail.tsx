import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useThemeValue } from '../theme/ThemeContext';

/**
 * The view switcher. Sessions sits first and is the app's default; everything
 * else is a secondary destination that opens on demand. The theme toggle sits
 * at the bottom, separated from the destinations above it.
 */

export type ViewId = 'sessions' | 'overview' | 'hotspots' | 'assistant' | 'sync' | 'settings';

interface RailEntry {
  id: ViewId;
  label: string;
  /** Inline SVG path data, so the rail needs no icon font or remote asset. */
  icon: JSX.Element;
}

const ENTRIES: RailEntry[] = [
  {
    id: 'sessions',
    label: 'Sessions',
    icon: (
      <>
        <rect x="3" y="4" width="18" height="2.5" rx="1.25" />
        <rect x="3" y="10.75" width="18" height="2.5" rx="1.25" />
        <rect x="3" y="17.5" width="12" height="2.5" rx="1.25" />
      </>
    ),
  },
  {
    id: 'overview',
    label: 'Local Overview',
    icon: (
      <>
        <rect x="3" y="12" width="4.5" height="9" rx="1" />
        <rect x="9.75" y="7" width="4.5" height="14" rx="1" />
        <rect x="16.5" y="3" width="4.5" height="18" rx="1" />
      </>
    ),
  },
  {
    id: 'hotspots',
    label: 'Context Hotspots',
    icon: <path d="M12 2c2.5 3.5 6 5.5 6 10a6 6 0 1 1-12 0c0-4.5 3.5-6.5 6-10Zm0 16a4 4 0 0 0 4-4c0-2.2-1.6-3.6-4-6.6-2.4 3-4 4.4-4 6.6a4 4 0 0 0 4 4Z" />,
  },
  {
    id: 'assistant',
    label: 'AI Helper',
    icon: <path d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4V6a2 2 0 0 1 2-2Z" />,
  },
  {
    id: 'sync',
    label: 'Sync',
    icon: <path d="M12 4a8 8 0 0 1 7.5 5.2l-2 .7A6 6 0 0 0 6.6 11H10l-4.5 5L1 11h3.6A8 8 0 0 1 12 4Zm0 16a8 8 0 0 1-7.5-5.2l2-.7A6 6 0 0 0 17.4 13H14l4.5-5L23 13h-3.6A8 8 0 0 1 12 20Z" />,
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4Zm9-2c0-.6-.05-1.2-.15-1.75l2-1.55-2-3.4-2.35.95a8.5 8.5 0 0 0-3-1.75L15.15 2h-4l-.35 2.5a8.5 8.5 0 0 0-3 1.75L5.45 5.3l-2 3.4 2 1.55a8.6 8.6 0 0 0 0 3.5l-2 1.55 2 3.4 2.35-.95a8.5 8.5 0 0 0 3 1.75l.35 2.5h4l.35-2.5a8.5 8.5 0 0 0 3-1.75l2.35.95 2-3.4-2-1.55c.1-.55.15-1.15.15-1.75Z" />,
  },
];

interface Props {
  active: ViewId;
  onSelect: (view: ViewId) => void;
}

export function ActivityRail({ active, onSelect }: Props): JSX.Element {
  const { theme, toggle } = useThemeValue();
  const [version, setVersion] = useState('');
  useEffect(() => {
    void window.desktop
      ?.getVersion()
      .then(setVersion)
      .catch(() => undefined);
  }, []);
  return (
    <nav className="rail" aria-label="Views">
      {ENTRIES.map((entry) => (
        <button
          key={entry.id}
          type="button"
          className="rail-button"
          aria-current={active === entry.id}
          aria-label={entry.label}
          title={entry.label}
          onClick={() => onSelect(entry.id)}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            {entry.icon}
          </svg>
        </button>
      ))}

      {/* Pinned to the bottom: an appearance control, not a destination. */}
      <button
        type="button"
        className="rail-button rail-button-end"
        onClick={toggle}
        aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          {theme === 'dark' ? (
            // Showing a sun in dark mode: the icon is the destination, not the
            // current state, which is what a single toggle should signal.
            <>
              <circle cx="12" cy="12" r="4.2" />
              <path d="M12 1.8v3M12 19.2v3M1.8 12h3M19.2 12h3M4.8 4.8l2.1 2.1M17.1 17.1l2.1 2.1M19.2 4.8l-2.1 2.1M6.9 17.1l-2.1 2.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
            </>
          ) : (
            <path d="M21 13.2A9 9 0 1 1 10.8 3a7.2 7.2 0 0 0 10.2 10.2Z" />
          )}
        </svg>
      </button>

      {/*
        macOS hides the title text under `hiddenInset`, so the version needs a
        home inside the window rather than only in the title bar.
      */}
      {version !== '' && (
        <span className="rail-version" title={`Agent Observability ${version}`}>
          v{version}
        </span>
      )}
    </nav>
  );
}
