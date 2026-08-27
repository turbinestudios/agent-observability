import type { JSX } from 'react';
import { useState } from 'react';
import { SessionsView } from './views/sessions/SessionsView';
import { PlaceholderView } from './views/PlaceholderView';
import { ActivityRail } from './components/ActivityRail';
import type { ViewId } from './components/ActivityRail';
import { ThemeProvider } from './theme/ThemeContext';
import './app.css';

/**
 * The app shell.
 *
 * Sessions is the default and permanently mounted view — switching to another
 * view hides it rather than unmounting, so returning to a long, scrolled list
 * is instant and never re-queries. The other views are secondary by design:
 * they load only when first opened, so nothing competes with sessions for
 * startup work.
 */
export function App(): JSX.Element {
  const [view, setView] = useState<ViewId>('sessions');

  return (
    <ThemeProvider>
      <div className="app">
        <ActivityRail active={view} onSelect={setView} />
        <main className="app-main">
          <div className="view-layer" hidden={view !== 'sessions'}>
            <SessionsView />
          </div>
          {view !== 'sessions' && (
            <div className="view-layer">
              <PlaceholderView view={view} />
            </div>
          )}
        </main>
      </div>
    </ThemeProvider>
  );
}
