import type { JSX } from 'react';
import { useState } from 'react';
import { SessionsView } from './views/sessions/SessionsView';
import { OverviewView } from './views/overview/OverviewView';
import { SettingsView } from './views/settings/SettingsView';
import { HotspotsView } from './views/hotspots/HotspotsView';
import { PlaceholderView } from './views/PlaceholderView';
import type { OpenSessionIntent } from './views/sessions/SessionsView';
import { ActivityRail } from './components/ActivityRail';
import { ChangelogDialog } from './components/ChangelogDialog';
import type { ViewId } from './components/ActivityRail';
import { ThemeProvider } from './theme/ThemeContext';
import './app.css';

/**
 * The app shell.
 *
 * Dashboard (overview) is the view the app opens on. Sessions is permanently
 * mounted regardless — switching away hides it rather than unmounting, so a
 * long, scrolled list is instant to return to and never re-queries. The
 * remaining views load only when first opened.
 *
 * Because Sessions is always mounted, another view can hand it a session to
 * open: the intent is held here and passed down, which is why it carries an
 * `at` timestamp — asking twice for the SAME session must still count as two
 * requests, or the second click would do nothing.
 */
export function App(): JSX.Element {
  const [view, setView] = useState<ViewId>('overview');
  const [openIntent, setOpenIntent] = useState<OpenSessionIntent | undefined>(undefined);
  // A dialog, not a view: it overlays whatever you were looking at and returns
  // you to it, so it must not disturb `view`.
  const [changelogOpen, setChangelogOpen] = useState(false);

  return (
    <ThemeProvider>
      <div className="app">
        <ActivityRail active={view} onSelect={setView} onShowChangelog={() => setChangelogOpen(true)} />
        <main className="app-main">
          <div className="view-layer" hidden={view !== 'sessions'}>
            <SessionsView openIntent={openIntent} />
          </div>
          {/*
            Mounted on first open and kept alive after, so returning to it is
            instant and does not re-query. Sessions stays mounted for the same
            reason; the remaining views are still placeholders.
          */}
          {view === 'overview' && (
            <div className="view-layer">
              <OverviewView />
            </div>
          )}
          {view === 'hotspots' && (
            <div className="view-layer">
              <HotspotsView
                onOpenSession={(source, sessionId) => {
                  setOpenIntent({ source, sessionId, at: Date.now() });
                  setView('sessions');
                }}
              />
            </div>
          )}
          {/* Remounted per open, so the snapshot re-reads the config each time. */}
          {view === 'settings' && (
            <div className="view-layer">
              <SettingsView />
            </div>
          )}
          {view !== 'sessions' && view !== 'overview' && view !== 'hotspots' && view !== 'settings' && (
            <div className="view-layer">
              <PlaceholderView view={view} />
            </div>
          )}
        </main>
        {changelogOpen && <ChangelogDialog onClose={() => setChangelogOpen(false)} />}
      </div>
    </ThemeProvider>
  );
}
