import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { SessionsView } from './views/sessions/SessionsView';
import { OverviewView } from './views/overview/OverviewView';
import { SettingsView } from './views/settings/SettingsView';
import { HotspotsView } from './views/hotspots/HotspotsView';
import type { HotspotFocusIntent } from './views/hotspots/HotspotsView';
import { RetroView } from './views/retro/RetroView';
import { ImproveView } from './views/improve/ImproveView';
import type { ImproveIntent } from './views/improve/ImproveView';
import { AssistantView } from './views/assistant/AssistantView';
import type { AskAiIntent } from './views/assistant/AssistantView';
import { WorkspaceView } from './views/workspace/WorkspaceView';
import { TeamView } from './views/team/TeamView';
import { useLiveNotifications } from './views/workspace/useLiveBoard';
import { useInbox } from './views/workspace/useInbox';
import type { OpenSessionIntent, SessionFilterIntent } from './views/sessions/SessionsView';
import type { SessionFilters } from './views/sessions/filters';
import { enabledSources } from './views/sessions/format';
import { ActivityRail } from './components/ActivityRail';
import { hiddenRailEntries } from './components/railHidden';
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
import { RunView } from './views/run/RunView';
import type { RunIntent } from './views/run/runViewModel';
import { RUN_DOOR_EVENT, setRunEnabled, type RunDoorRequest } from './views/run/doors';
import { useRunActiveRelay, useRunBusy } from './views/run/useRun';

/**
 * The app shell.
 *
 * Dashboard (overview) is the view the app opens on. Sessions is permanently
 * mounted regardless — switching away hides it rather than unmounting, so a
 * long, scrolled list is instant to return to and never re-queries. The
 * remaining views load only when first opened.
 *
 * Because Sessions is always mounted, another view can hand it a session to
 * open — or a set of filters to narrow to: the intent is held here and passed
 * down, which is why it carries an `at` timestamp — asking twice for the SAME
 * session or the same filters must still count as two requests, or the second
 * click would do nothing.
 */
export function App(): JSX.Element {
  const [view, setView] = useState<ViewId>('overview');
  const [openIntent, setOpenIntent] = useState<OpenSessionIntent | undefined>(undefined);
  // "Show me the sessions behind this chart mark", raised by the Dashboard.
  const [filterIntent, setFilterIntent] = useState<SessionFilterIntent | undefined>(undefined);
  const openSessions = (filters: SessionFilters): void => {
    setFilterIntent({ ...filters, at: Date.now() });
    setView('sessions');
  };
  // "Ask AI about this session": held here like the open intent, because the
  // Sessions view raises it while the AI Helper consumes it.
  const [askIntent, setAskIntent] = useState<AskAiIntent | undefined>(undefined);
  // "Review this context file": raised by the Dashboard's hotspot card,
  // consumed by the Hotspots view.
  const [hotspotIntent, setHotspotIntent] = useState<HotspotFocusIntent | undefined>(undefined);
  const openHotspot = (file?: string): void => {
    setHotspotIntent({ ...(file !== undefined ? { file } : {}), at: Date.now() });
    setView('hotspots');
  };
  // "Improve this repository": raised by the Hotspots and Retro headers,
  // consumed by the Improve view (arrives pre-scoped to the repository).
  const [improveIntent, setImproveIntent] = useState<ImproveIntent | undefined>(undefined);
  const openImprove = (repository: string): void => {
    setImproveIntent({ repository, at: Date.now() });
    setView('improve');
  };
  const openSession = (source: string, sessionId: string): void => {
    setOpenIntent({ source, sessionId, at: Date.now() });
    setView('sessions');
  };
  // Live-session notifications live in the shell, not the Workspace view, so a
  // toast still arrives while another view is open. The toggle is re-read each
  // time the user leaves Settings.
  const [settingsVersion, setSettingsVersion] = useState(0);
  const lastView = useRef<ViewId>(view);
  useEffect(() => {
    if (lastView.current === 'settings' && view !== 'settings') {
      setSettingsVersion((v) => v + 1);
    }
    lastView.current = view;
  }, [view]);
  // The attention inbox is held here for the same reason: the rail badge has to
  // count from any view, and the Workspace view reads the same snapshot.
  // Run: whether it is on (the rail entry and every door follow it), and the
  // door requests other views raise. A door only prefills the goal box; the
  // data host builds the text and nothing is sent until the user presses Start.
  const [runOn, setRunOn] = useState(false);
  // Team is off until turned on in Settings: its rail entry follows, as Run's does.
  const [teamOn, setTeamOn] = useState(false);
  // The sources switched on in Settings: the Sessions filter offers only these.
  const [sourcesOn, setSourcesOn] = useState<string[] | undefined>(undefined);
  // Run stays mounted once it has been opened, so a goal being written, the
  // session on screen and a half-typed follow-up survive a look elsewhere.
  const [runOpened, setRunOpened] = useState(false);
  useEffect(() => {
    if (view === 'run') {
      setRunOpened(true);
    }
  }, [view]);
  const [runIntent, setRunIntent] = useState<RunIntent | undefined>(undefined);
  const [runOpenSession, setRunOpenSession] = useState<{ sessionId: string; at: number } | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    dataHost
      .call('settings.get')
      .then((snapshot) => {
        if (!cancelled) {
          setRunOn(snapshot.runEnabled);
          setTeamOn(snapshot.teamEnabled);
          setSourcesOn(enabledSources(snapshot));
          setRunEnabled(snapshot.runEnabled);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [settingsVersion]);
  useEffect(() => {
    const onDoor = (event: Event): void => {
      const request = (event as CustomEvent<RunDoorRequest>).detail;
      if ('openSessionId' in request) {
        setRunOpenSession({ sessionId: request.openSessionId, at: Date.now() });
        setView('run');
        return;
      }
      dataHost
        .call('run.prefill', request.prefill)
        .then((prefill) => {
          setRunIntent({ prefill, at: Date.now() });
          setView('run');
        })
        .catch(() => setView('run'));
    };
    window.addEventListener(RUN_DOOR_EVENT, onDoor);
    return () => window.removeEventListener(RUN_DOOR_EVENT, onDoor);
  }, []);
  useRunActiveRelay();
  const runBusy = useRunBusy(runOn);
  const inbox = useInbox();
  useLiveNotifications(settingsVersion, openSession, inbox.snapshot);
  // Leaving Workspace means the user has looked: nothing there stays "new".
  const markInbox = inbox.mark;
  useEffect(() => {
    if (view !== 'workspace') {
      return undefined;
    }
    return () => markInbox('all', 'seen');
  }, [view, markInbox]);
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
  // An update status exists only after the user consents to a download, and it
  // never returns to undefined — so this is a latch: from the first byte on,
  // the upgrade owns the window's blocking layers for the rest of the session.
  const upgradeUnderway = updateStatus !== undefined;
  const setupDialog = copilotSetupDialogState(
    copilotSetup,
    startupDone,
    upgradeUnderway,
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
        <ActivityRail
          hidden={hiddenRailEntries({ run: runOn, team: teamOn })}
          active={view}
          onSelect={setView}
          onShowChangelog={() => setChangelogOpen(true)}
          badges={{ workspace: inbox.snapshot?.unread ?? 0 }}
          busy={runBusy ? ['run'] : []}
        />
        <main className="app-main">
          <div className="view-layer" hidden={view !== 'sessions'}>
            <SessionsView
              enabledSources={sourcesOn}
              openIntent={openIntent}
              filterIntent={filterIntent}
              onAskAi={(source, sessionId, prefill) => {
                setAskIntent({ source, sessionId, ...(prefill !== undefined ? { prefill } : {}), at: Date.now() });
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
              <OverviewView onOpenSessions={openSessions} onOpenHotspot={openHotspot} />
            </div>
          )}
          {view === 'workspace' && (
            <div className="view-layer">
              <WorkspaceView
                inbox={inbox}
                onOpenSession={openSession}
                onOpenSessions={openSessions}
                onAskAi={(prefill) => {
                  setAskIntent({ prefill, at: Date.now() });
                  setView('assistant');
                }}
                onImprove={openImprove}
                onOpenHotspot={openHotspot}
              />
            </div>
          )}
          {view === 'hotspots' && (
            <div className="view-layer">
              <HotspotsView
                focusIntent={hotspotIntent}
                onImprove={openImprove}
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
                onOpenSessions={openSessions}
                onImprove={openImprove}
                onOpenSession={(source, sessionId) => {
                  setOpenIntent({ source, sessionId, at: Date.now() });
                  setView('sessions');
                }}
              />
            </div>
          )}
          {view === 'improve' && (
            <div className="view-layer">
              <ImproveView focusIntent={improveIntent} />
            </div>
          )}
          {(runOpened || view === 'run') && (
            <div className="view-layer" hidden={view !== 'run'}>
              <RunView
                active={view === 'run'}
                intent={runIntent}
                openSession={runOpenSession}
                onOpenSettings={() => setView('settings')}
              />
            </div>
          )}
          {view === 'team' && (
            <div className="view-layer">
              <TeamView onOpenSettings={() => setView('settings')} />
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
          then the update dialog, then the Copilot setup offer. An upgrade the
          user consented to RETIRES the startup overlay outright — it must not
          cover the download, and it must not come back over an upgrade even
          when the download is sent to the background (its startup machine
          keeps running underneath, so the view warm-up still happens). The
          dialog's own z-index outranks the startup overlay as well, so even a
          status-timing gap cannot paint "starting up" over the download. The
          setup offer additionally stays away for the whole upgrade: offering
          new setup while the app is being replaced helps nobody.
        */}
        <StartupOverlay suppressed={upgradeUnderway} onDone={() => setStartupDone(true)} />
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
