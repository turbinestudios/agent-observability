import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { dataHost } from '../../api/client';
import { Spinner } from '../../components/Spinner';
import { formatRelative, shortRepo } from '../sessions/format';
import { GoalBox } from './GoalBox';
import { InputCard, PermissionCard } from './PermissionCard';
import { RunNotice } from './RunNotice';
import { Transcript } from './Transcript';
import { canSend, canStop, runStatusLabel } from './run';
import { availabilityProblem, runGate, sortRunSessions, type RunIntent } from './runViewModel';
import { useRunHost, useRunSession } from './useRun';
import './run.css';

/**
 * Run: start or continue a GitHub Copilot session from the app, and answer
 * each thing it asks to do.
 *
 * The session is hosted by the data host through the Copilot SDK, on the
 * user's own installed `copilot` and their own Copilot login. This view only
 * shows what the host reports and relays what the user decides: it holds no
 * session state of its own, so it can be closed and reopened at any time.
 */
interface Props {
  /** Whether the view is on screen. It stays mounted while another view is open, so a draft is kept. */
  active: boolean;
  /** A prefill raised by a door in another view. Fills the goal box; sends nothing. */
  intent?: RunIntent;
  /** Open a session the app is already hosting (from the live board). */
  openSession?: { sessionId: string; at: number };
  onOpenSettings: () => void;
}

const DOOR_ORIGIN: Record<string, string> = {
  'continue-session': 'the session you chose to continue',
  'repo-digest': 'the repository digest',
  'improve-plan': 'the improvement plan',
  'retro-advice': 'the retrospective',
  'handoff-brief': 'the hand-off brief',
};

export function RunView({ active, intent, openSession, onOpenSettings }: Props): JSX.Element {
  const host = useRunHost();
  // Coming back to the view: Settings may have changed since, so ask again.
  const reloadHost = host.reload;
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) {
      reloadHost();
    }
    wasActive.current = active;
  }, [active, reloadHost]);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const session = useRunSession(selected);
  const [goal, setGoal] = useState('');
  const [repository, setRepository] = useState('');
  const [model, setModel] = useState('');
  const [door, setDoor] = useState<RunIntent['prefill']['door']>('blank');
  const [resumeId, setResumeId] = useState<string | undefined>(undefined);
  const [followUp, setFollowUp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // A door arrived: show its text in the goal box. Nothing is sent.
  useEffect(() => {
    if (intent === undefined) {
      return;
    }
    setSelected(undefined);
    setGoal(intent.prefill.goal);
    setDoor(intent.prefill.door);
    setResumeId(intent.prefill.resumeSessionId);
    if (intent.prefill.repository !== undefined) {
      setRepository(intent.prefill.repository);
    }
  }, [intent]);

  useEffect(() => {
    if (openSession !== undefined) {
      setSelected(openSession.sessionId);
    }
  }, [openSession]);

  const fail = (err: Error): void => setError(err.message);

  const start = (): void => {
    setBusy(true);
    setError(undefined);
    const text = goal.trim();
    const request =
      resumeId !== undefined
        ? dataHost.call('run.resume', resumeId).then(async (info) => {
            if (text.length > 0) {
              await dataHost.call('run.send', info.sessionId, text);
            }
            return info;
          })
        : dataHost.call('run.start', { goal: text, repository, ...(model !== '' ? { model } : {}), door });
    request
      .then((info) => {
        setSelected(info.sessionId);
        setGoal('');
        setResumeId(undefined);
        setDoor('blank');
        host.reload();
      })
      .catch(fail)
      .finally(() => setBusy(false));
  };

  const gate = runGate(host.availability);
  if (host.availability === undefined || gate === undefined) {
    return host.error !== undefined ? (
      <div className="placeholder">
        <div>
          <h2>Run is not available</h2>
          <p>{host.error}</p>
        </div>
      </div>
    ) : (
      <div className="detail-loading" role="status" aria-live="polite">
        <Spinner size={36} stroke={3} />
      </div>
    );
  }
  if (!host.availability.enabled) {
    return (
      <div className="placeholder">
        <div>
          <h2>Run is turned off</h2>
          <p>Turn it on under Settings to start Copilot sessions from here.</p>
          <button type="button" className="modal-btn" onClick={onOpenSettings}>
            Open Settings
          </button>
        </div>
      </div>
    );
  }
  if (gate === 'notice') {
    return (
      <div className="run">
        <RunNotice onAccept={host.acknowledge} {...(host.error !== undefined ? { error: host.error } : {})} />
      </div>
    );
  }

  const problem = availabilityProblem(host.availability);
  const sessions = sortRunSessions(host.sessions);
  const current = sessions.find((s) => s.sessionId === selected);

  return (
    <div className="run">
      <aside className="run-sessions" aria-label="Sessions started here">
        <button type="button" className="modal-btn" onClick={() => setSelected(undefined)}>
          New session
        </button>
        <ul>
          {sessions.map((s) => (
            <li key={s.sessionId}>
              <button
                type="button"
                className="run-session"
                aria-current={s.sessionId === selected}
                onClick={() => setSelected(s.sessionId)}
              >
                <span className="run-session-title">{s.title ?? 'Untitled session'}</span>
                <span className="card-caption">
                  {runStatusLabel(s.status)} · {shortRepo(s.repository)} · {formatRelative(s.lastActivityMs)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <div className="run-main">
        {problem !== undefined && <div className="settings-error">{problem}</div>}
        {error !== undefined && <div className="settings-error">{error}</div>}
        {selected === undefined || session === undefined ? (
          <GoalBox
            goal={goal}
            onGoal={setGoal}
            repository={repository}
            onRepository={setRepository}
            model={model}
            onModel={setModel}
            repositories={host.repositories}
            availability={host.availability}
            busy={busy || gate === 'problem'}
            onStart={start}
            {...(DOOR_ORIGIN[door] !== undefined ? { origin: DOOR_ORIGIN[door] } : {})}
          />
        ) : (
          <>
            <header className="run-header">
              <h1>{current?.title ?? 'Session'}</h1>
              <span className={`run-status run-status-${session.status}`}>{runStatusLabel(session.status)}</span>
              {canStop(session.status) && (
                <button type="button" className="modal-btn" onClick={() => void dataHost.call('run.abort', selected).catch(fail)}>
                  Stop
                </button>
              )}
              <button
                type="button"
                className="modal-btn"
                title="Stops hosting this session here. It stays saved and can be continued later."
                onClick={() => {
                  void dataHost.call('run.close', selected).then(() => host.reload()).catch(fail);
                  setSelected(undefined);
                }}
              >
                Close
              </button>
            </header>
            <Transcript items={session.items} />
            {session.permission !== undefined && (
              <PermissionCard
                request={session.permission}
                onDecide={(decision, feedback) =>
                  void dataHost
                    .call('run.permission.respond', (session.permission as { requestId: string }).requestId, decision, feedback)
                    .catch(fail)
                }
              />
            )}
            {session.input !== undefined && (
              <InputCard
                request={session.input}
                onAnswer={(answer) =>
                  void dataHost.call('run.input.respond', (session.input as { requestId: string }).requestId, answer).catch(fail)
                }
              />
            )}
            <form
              className="run-followup"
              onSubmit={(e) => {
                e.preventDefault();
                const text = followUp.trim();
                if (text.length === 0) {
                  return;
                }
                setFollowUp('');
                void dataHost.call('run.send', selected, text).catch(fail);
              }}
            >
              <textarea
                value={followUp}
                placeholder="Continue the session…"
                aria-label="Follow-up message"
                disabled={!canSend(session.status)}
                onChange={(e) => setFollowUp(e.target.value)}
              />
              <button type="submit" className="modal-btn primary" disabled={!canSend(session.status) || followUp.trim().length === 0}>
                Send
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
