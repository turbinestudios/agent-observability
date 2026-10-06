import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import type { OverviewWindow, RepositoryCards as RepositoryCardsData } from '../../../../shared/rpc';
import { dataHost } from '../../api/client';
import type { SessionFilters } from '../sessions/filters';
import { WindowSelector } from '../overview/WindowSelector';
import { persistWindow, readStoredWindow, windowDescription } from '../overview/window';
import { InboxSection } from './InboxSection';
import { LiveBoard } from './LiveBoard';
import type { InboxApi } from './useInbox';
import { RepoHub } from './RepoHub';
import { RepositoryCards } from './RepositoryCards';
import { useLiveBoard } from './useLiveBoard';
import './workspace.css';

/**
 * The Workspace: what your agents are doing right now, across every
 * repository, and one hub per repository below it.
 *
 * Borrowed from the cockpit idea — many sessions, one board, a status per
 * card — without becoming one: nothing here launches, resumes or steers a
 * session, and no hook is installed into the agents. The board reads the
 * transcripts the agents already write; the hubs read the local index.
 */
interface Props {
  /** The attention inbox, owned by the app shell so the rail badge shares it. */
  inbox?: InboxApi;
  onOpenSession: (source: string, sessionId: string) => void;
  onOpenSessions: (filters: SessionFilters) => void;
  /** Opens the AI Helper with a question filled in; nothing is sent until the user presses Send. */
  onAskAi: (prefill: string) => void;
  onImprove: (repository: string) => void;
  onOpenHotspot: (file?: string) => void;
}

export function WorkspaceView({ inbox, onOpenSession, onOpenSessions, onAskAi, onImprove, onOpenHotspot }: Props): JSX.Element {
  const { snapshot, error: liveError } = useLiveBoard();
  const [chosen, setChosen] = useState<OverviewWindow>(readStoredWindow);
  const [repository, setRepository] = useState<string | undefined>(undefined);
  const [cards, setCards] = useState<RepositoryCardsData | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const chooseWindow = (next: OverviewWindow): void => {
    setChosen(next);
    persistWindow(next);
  };

  const loadCards = useCallback(() => {
    dataHost
      .call('workspace.repositories', { window: chosen })
      .then((next) => {
        setCards(next);
        setError(undefined);
      })
      .catch((err: Error) => setError(err.message));
  }, [chosen]);

  useEffect(() => {
    loadCards();
    const offProgress = dataHost.on('index.progress', (event) => {
      if (event.event === 'index.progress' && event.status.phase === 'idle') {
        loadCards();
      }
    });
    const offAnalysis = dataHost.on('analysis.progress', () => loadCards());
    return () => {
      offProgress();
      offAnalysis();
    };
  }, [loadCards]);

  // Live counts on the cards follow the board without a datahost round trip.
  useEffect(() => {
    if (snapshot === undefined) {
      return;
    }
    setCards((current) => {
      if (current === undefined) {
        return current;
      }
      const live = new Map<string, { live: number; waiting: number }>();
      for (const row of snapshot.rows) {
        if (row.status === 'finished') {
          continue;
        }
        const entry = live.get(row.repository) ?? { live: 0, waiting: 0 };
        entry.live += 1;
        if (row.status === 'waiting') {
          entry.waiting += 1;
        }
        live.set(row.repository, entry);
      }
      return {
        ...current,
        cards: current.cards.map((card) => ({
          ...card,
          live: live.get(card.repository)?.live ?? 0,
          waiting: live.get(card.repository)?.waiting ?? 0,
        })),
      };
    });
  }, [snapshot]);

  if (repository !== undefined) {
    return (
      <div className="workspace">
        <RepoHub
          repository={repository}
          window={chosen}
          onWindow={chooseWindow}
          live={snapshot}
          onBack={() => setRepository(undefined)}
          onOpenSession={onOpenSession}
          onOpenSessions={onOpenSessions}
          onAskAi={onAskAi}
          onImprove={onImprove}
          onOpenHotspot={onOpenHotspot}
        />
      </div>
    );
  }

  return (
    <div className="workspace">
      <header className="workspace-header">
        <div className="workspace-title">
          <h1>Workspace</h1>
          <WindowSelector value={chosen} onChange={chooseWindow} />
        </div>
        <p>
          Every agent session running on this computer, then one hub per repository for {windowDescription(chosen)}.
          Status comes from the end of each session&apos;s own log; nothing is installed into your agents and nothing is
          uploaded.
        </p>
      </header>
      {error !== undefined && <div className="settings-error">{error}</div>}
      {inbox !== undefined && (
        <InboxSection snapshot={inbox.snapshot} mark={inbox.mark} onOpenSession={onOpenSession} />
      )}
      <LiveBoard snapshot={snapshot} error={liveError} onOpenSession={onOpenSession} />
      <RepositoryCards data={cards} onOpen={setRepository} />
    </div>
  );
}
