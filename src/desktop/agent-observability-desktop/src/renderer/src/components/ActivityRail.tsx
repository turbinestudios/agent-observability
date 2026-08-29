import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useThemeValue } from '../theme/ThemeContext';
import { useUpdateStatus } from '../updates/useUpdateStatus';
import { useRailExpanded } from './useRailExpanded';
import { UpdateIndicator } from './UpdateIndicator';

/**
 * The view switcher. Dashboard sits first and is the app's default; everything
 * else is a secondary destination that opens on demand. The theme toggle sits
 * at the bottom, separated from the destinations above it.
 *
 * It opens showing labels beside the icons and collapses to the icon strip on
 * demand — see {@link useRailExpanded}. Every button keeps its `title`, so the
 * collapsed strip still names its destinations on hover.
 */

export type ViewId = 'sessions' | 'overview' | 'hotspots' | 'retro' | 'assistant' | 'settings';

interface RailEntry {
  id: ViewId;
  label: string;
  /** Inline SVG path data, so the rail needs no icon font or remote asset. */
  icon: JSX.Element;
}

const ENTRIES: RailEntry[] = [
  {
    id: 'overview',
    label: 'Dashboard',
    icon: (
      <>
        <rect x="3" y="12" width="4.5" height="9" rx="1" />
        <rect x="9.75" y="7" width="4.5" height="14" rx="1" />
        <rect x="16.5" y="3" width="4.5" height="18" rx="1" />
      </>
    ),
  },
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
    id: 'hotspots',
    label: 'Context Hotspots',
    icon: <path d="M12 2c2.5 3.5 6 5.5 6 10a6 6 0 1 1-12 0c0-4.5 3.5-6.5 6-10Zm0 16a4 4 0 0 0 4-4c0-2.2-1.6-3.6-4-6.6-2.4 3-4 4.4-4 6.6a4 4 0 0 0 4 4Z" />,
  },
  {
    id: 'retro',
    label: 'Retro',
    // A backwards-looping arrow: looking back over what already ran.
    icon: (
      <path d="M12 4.5V1.6L6.8 6l5.2 4.4V7.5a6 6 0 1 1-5.9 7.1l-2.5.5A8.5 8.5 0 1 0 12 4.5Z" />
    ),
  },
  {
    id: 'assistant',
    label: 'AI Helper',
    icon: <path d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4V6a2 2 0 0 1 2-2Z" />,
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
  /** Opens the What's new dialog. Not a destination, so not a ViewId. */
  onShowChangelog: () => void;
}

export function ActivityRail({ active, onSelect, onShowChangelog }: Props): JSX.Element {
  const { theme, toggle } = useThemeValue();
  const { expanded, toggle: toggleExpanded } = useRailExpanded();
  const update = useUpdateStatus();
  const [version, setVersion] = useState('');
  useEffect(() => {
    void window.desktop
      ?.getVersion()
      .then(setVersion)
      .catch(() => undefined);
  }, []);
  // The theme button's accessible name has to match the words on it once they
  // are visible, so the short form doubles as the label when expanded.
  const themeAction = theme === 'dark' ? 'Light theme' : 'Dark theme';
  const themeHint = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  return (
    <nav className={expanded ? 'rail rail-expanded' : 'rail'} aria-label="Views">
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
          {expanded && <span className="rail-label">{entry.label}</span>}
        </button>
      ))}

      {/*
        Pinned to the bottom, below the destinations: neither of these navigates
        anywhere. The release notes sit next to the version they explain.
      */}
      <button
        type="button"
        className="rail-button rail-button-end"
        onClick={onShowChangelog}
        aria-label="What's new"
        title="What's new"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M11 2.5 12.6 7l4.4 1.6-4.4 1.6L11 14.7 9.4 10.2 5 8.6 9.4 7 11 2.5Z" />
          <path d="M17.5 13.5l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9.9-2.4Z" />
        </svg>
        {expanded && <span className="rail-label">What&apos;s new</span>}
      </button>

      <button
        type="button"
        className="rail-button"
        onClick={toggle}
        aria-label={expanded ? themeAction : themeHint}
        title={themeHint}
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
        {expanded && <span className="rail-label">{themeAction}</span>}
      </button>

      {/*
        The width switch itself. Last, because it acts on the rail rather than
        on anything the rail leads to — and the chevron points the way the rail
        will move.
      */}
      <button
        type="button"
        className="rail-button"
        onClick={toggleExpanded}
        aria-expanded={expanded}
        aria-label={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
        title={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d={expanded ? 'M14.5 6.5 9 12l5.5 5.5' : 'M9.5 6.5 15 12l-5.5 5.5'}
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
        {expanded && <span className="rail-label">Collapse</span>}
      </button>

      {/* Above the version, and only while an update is in flight. */}
      {update !== undefined && <UpdateIndicator status={update} />}

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
