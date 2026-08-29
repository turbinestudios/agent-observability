import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { SessionsView } from './views/sessions/SessionsView';
import { OverviewView } from './views/overview/OverviewView';
import { SettingsView } from './views/settings/SettingsView';
import { HotspotsView } from './views/hotspots/HotspotsView';
import { RetroView } from './views/retro/RetroView';
import { AssistantView } from './views/assistant/AssistantView';
import type { AskAiIntent } from './views/assistant/AssistantView';
import type { OpenSessionIntent } from './views/sessions/SessionsView';
import { ActivityRail } from './components/ActivityRail';
import { ChangelogDialog } from './components/ChangelogDialog';
import { CopilotSetupDialog } from './components/CopilotSetupDialog';
import { copilotSetupDialogState } from './components/copilotSetupState';
import { StartupOverlay } from './components/StartupOverlay';
import { UpdateDialogView, updateDialogState } from './components/UpdateDialog';
import type { ViewId } from './components/ActivityRail';
import { useUpdateStatus } from './updates/useUpdateStatus';
import { ThemeProvider } from './theme/ThemeContext';
import { dataHost } from './api/client';
import type { CopilotSetupStatus } from '../../shared/rpc';
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
  // "Ask AI about this session": held here like the open intent, because the
  // Sessions view raises it while the AI Helper consumes it.
  const [askIntent, setAskIntent] = useState<AskAiIntent | undefined>(undefined);
  // A dialog, not a view: it overlays whatever you were looking at and returns
  // you to it, so it must not disturb `view`.
  const [changelogOpen, setChangelogOpen] = useState(false);
  // The update download. Its dismissal is held here rather than inside the
  // dialog because the startup overlay has to know whether it is on screen —
  // see the overlays at the bottom of the tree.
  const updateStatus = useUpdateStatus();
  const [dismissedUpdate, setDismissedUpdate] = useState<string | undefined>(undefined);
  const updateDialog = updateDialogState(updateStatus, dismissedUpdate);

  // The Copilot setup offer. Fetched only once the startup overlay has lifted,
  // so the prompt can never race the first paint; the datahost decides whether
  // it is warranted (`shouldPrompt`), the shell only arbitrates overlays.
  const [startupDone, setStartupDone] = useState(false);
  const [copilotSetup, setCopilotSetup] = useState<CopilotSetupStatus | undefined>(undefined);
  const [dismissedSetup, setDismissedSetup] = useState(false);
  useEffect(() => {
    if (!startupDone) {
      return;
    }
    let cancelled = false;
    dataHost
      .call('copilot.setupStatus')
      .then((next) => {
        if (!cancelled) {
          setCopilotSetup(next);
        }
      })
      .catch(() => undefined); // No status, no prompt; Settings still has the fix.
    return () => {
      cancelled = true;
    };
  }, [startupDone]);
  const setupDialog = copilotSetupDialogState(
    copilotSetup,
    startupDone,
    updateDialog !== undefined,
    dismissedSetup,
  );

  // macOS runs frameless (`titleBarStyle: 'hiddenInset'`), so the renderer
  // must supply what the OS chrome normally would: a strip that clears the
  // traffic lights and acts as the drag handle. Other platforms keep their
  // native title bar and get neither.
  const isMac = navigator.userAgent.includes('Macintosh');

  return (
    <ThemeProvider>
      <div className={isMac ? 'app app-mac' : 'app'}>
        {isMac && <div className="titlebar-drag" aria-hidden="true" />}
        <ActivityRail active={view} onSelect={setView} onShowChangelog={() => setChangelogOpen(true)} />
        <main className="app-main">
          <div className="view-layer" hidden={view !== 'sessions'}>
            <SessionsView
              openIntent={openIntent}
              onAskAi={(source, sessionId) => {
                setAskIntent({ source, sessionId, at: Date.now() });
                setView('assistant');
              }}
            />
          </div>
          {/*
            Mounted on first open and kept alive after, so returning to it is
            instant and does not re-query. Sessions stays mounted for the same
            reason; the AI Helper's thread lives in the datahost, so it can
            afford to remount.
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
          {view === 'retro' && (
            <div className="view-layer">
              <RetroView
                onOpenSession={(source, sessionId) => {
                  setOpenIntent({ source, sessionId, at: Date.now() });
                  setView('sessions');
                }}
              />
            </div>
          )}
          {view === 'assistant' && (
            <div className="view-layer">
              <AssistantView
                askIntent={askIntent}
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
        </main>
        {changelogOpen && <ChangelogDialog onClose={() => setChangelogOpen(false)} />}
        {/*
          One blocking overlay at a time, in a strict order: startup overlay,
          then the update dialog, then the Copilot setup offer. The update
          dialog is what the user just consented to and it blocks the window
          itself, so the startup overlay stands down while it is up — and
          comes back if the download is sent to the background before the
          first index pass has finished. The setup offer waits for both.
        */}
        <StartupOverlay
          suppressed={updateDialog !== undefined}
          onDone={() => setStartupDone(true)}
        />
        {updateDialog !== undefined && (
          <UpdateDialogView
            status={updateDialog.status}
            onDismiss={() => setDismissedUpdate(updateDialog.key)}
          />
        )}
        {setupDialog !== undefined && (
          <CopilotSetupDialog
            status={setupDialog.status}
            onDismiss={() => setDismissedSetup(true)}
          />
        )}
      </div>
    </ThemeProvider>
  );
}
