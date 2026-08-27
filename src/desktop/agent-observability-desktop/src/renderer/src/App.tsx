import type { JSX } from 'react';
import { useState } from 'react';
import { SessionsView } from './views/sessions/SessionsView';
import { OverviewView } from './views/overview/OverviewView';
import { SettingsView } from './views/settings/SettingsView';
import { PlaceholderView } from './views/PlaceholderView';
import { ActivityRail } from './components/ActivityRail';
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
 */
export function App(): JSX.Element {
  const [view, setView] = useState<ViewId>('overview');

  return (
    <ThemeProvider>
      <div className="app">
        <ActivityRail active={view} onSelect={setView} />
        <main className="app-main">
          <div className="view-layer" hidden={view !== 'sessions'}>
            <SessionsView />
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
          {/* Remounted per open, so the snapshot re-reads the config each time. */}
          {view === 'settings' && (
            <div className="view-layer">
              <SettingsView />
            </div>
          )}
          {view !== 'sessions' && view !== 'overview' && view !== 'settings' && (
            <div className="view-layer">
              <PlaceholderView view={view} />
            </div>
          )}
        </main>
      </div>
    </ThemeProvider>
  );
}
