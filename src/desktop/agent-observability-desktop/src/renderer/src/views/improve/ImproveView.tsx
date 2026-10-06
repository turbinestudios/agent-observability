import type { JSX } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dataHost } from '../../api/client';
import type {
  AiBackendInfo,
  ApplyResult,
  ContextPlanSummary,
  ContextPlanView,
  FileDiffResult,
  HotspotsResult,
  ImproveRepoStatus,
  RetroResult,
} from '../../../../shared/rpc';
import { MAX_IMPROVE_HOTSPOTS, MAX_IMPROVE_SESSIONS, sessionKey } from '../../../../shared/rpc';
import { Spinner } from '../../components/Spinner';
import { formatRelative } from '../sessions/format';
import { verdictLabel } from '../sessions/retro';
import { categoryLabel, shortPath } from '../hotspots/hotspots';
import './improve.css';
import { openRunDoor, useRunEnabled } from '../run/doors';

/**
 * The Improve view: pick a repository, pick the context hotspots and rough
 * sessions that prove the friction, and ask your own AI CLI for a concrete
 * plan — with appliable edits — for the repo's context files.
 *
 * THE THIRD SANCTIONED EXCEPTION lives behind this view. Its two gates:
 * the default-off Settings toggle, and the per-generation dialog below naming
 * the vendor and payload. The datahost refuses independently of both.
 */

/** "Improve this repository", raised by the Hotspots/Retro header buttons. */
export interface ImproveIntent {
  repository: string;
  at: number;
}

interface Props {
  focusIntent?: ImproveIntent;
}

export function ImproveView({ focusIntent }: Props): JSX.Element {
  const runEnabled = useRunEnabled();
  const [repository, setRepository] = useState('');
  const [repositories, setRepositories] = useState<string[]>([]);
  /** True until the first repository scan answers, so the wait shows as a spinner. */
  const [reposLoading, setReposLoading] = useState(true);
  const [status, setStatus] = useState<ImproveRepoStatus | undefined>(undefined);
  const [hotspots, setHotspots] = useState<HotspotsResult | undefined>(undefined);
  const [retro, setRetro] = useState<RetroResult | undefined>(undefined);
  const [plans, setPlans] = useState<ContextPlanSummary[]>([]);
  const [plan, setPlan] = useState<ContextPlanView | undefined>(undefined);
  const [backend, setBackend] = useState<AiBackendInfo | undefined>(undefined);
  const [enabled, setEnabled] = useState<boolean | undefined>(undefined);
  const [pickedFiles, setPickedFiles] = useState<ReadonlySet<string>>(new Set());
  const [pickedSessions, setPickedSessions] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [applying, setApplying] = useState<string | undefined>(undefined);
  const consumedIntent = useRef<number | undefined>(undefined);

  // The repository lists both selection sources already ship with their scans.
  useEffect(() => {
    void Promise.allSettled([
      dataHost.call('hotspots.get', {}),
      dataHost.call('retro.get', {}),
    ]).then(([h, r]) => {
      const fromHotspots = h.status === 'fulfilled' ? h.value.repositories : [];
      const fromRetro = r.status === 'fulfilled' ? r.value.repositories : [];
      setRepositories([...new Set([...fromHotspots, ...fromRetro])].sort());
      setReposLoading(false);
    });
    dataHost
      .call('ai.backends')
      .then((all) => setBackend(all.find((b) => b.active)))
      .catch(() => undefined);
    dataHost
      .call('settings.get')
      .then((snapshot) => setEnabled(snapshot.improveEnabled))
      .catch(() => setEnabled(undefined));
  }, []);

  useEffect(() => {
    if (focusIntent !== undefined && focusIntent.at !== consumedIntent.current) {
      consumedIntent.current = focusIntent.at;
      setRepository(focusIntent.repository);
    }
  }, [focusIntent]);

  const loadRepo = useCallback(() => {
    if (repository === '') {
      setStatus(undefined);
      setHotspots(undefined);
      setRetro(undefined);
      setPlans([]);
      return;
    }
    // A failed status call must SAY so — an old data host (a dev run started
    // before this feature) rejects the method, and a silently disabled button
    // is the worst way to learn that.
    void dataHost
      .call('improve.repoStatus', repository)
      .then(setStatus)
      .catch((err: Error) => setStatus({ repository, error: err.message }));
    void dataHost.call('hotspots.get', { repository }).then(setHotspots).catch(() => undefined);
    void dataHost.call('retro.get', { repository }).then(setRetro).catch(() => undefined);
    void dataHost.call('improve.plans', repository).then(setPlans).catch(() => undefined);
  }, [repository]);

  useEffect(() => {
    // A repository change starts a fresh selection — a basket carried across
    // repos would generate a plan the datahost must refuse.
    setPickedFiles(new Set());
    setPickedSessions(new Set());
    setPlan(undefined);
    setError(undefined);
    loadRepo();
  }, [loadRepo]);

  const toggleFile = (file: string): void => {
    setPickedFiles((current) => {
      const next = new Set(current);
      if (next.has(file)) {
        next.delete(file);
      } else if (next.size < MAX_IMPROVE_HOTSPOTS) {
        next.add(file);
      }
      return next;
    });
  };

  const toggleSession = (key: string): void => {
    setPickedSessions((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else if (next.size < MAX_IMPROVE_SESSIONS) {
        next.add(key);
      }
      return next;
    });
  };

  const generate = (): void => {
    setConfirming(false);
    setGenerating(true);
    setError(undefined);
    const sessions = (retro?.rows ?? [])
      .filter((row) => pickedSessions.has(sessionKey(row.source, row.sessionId)))
      .map((row) => ({ source: row.source, sessionId: row.sessionId }));
    dataHost
      .call('improve.generate', { repository, hotspotFiles: [...pickedFiles], sessions })
      .then((result) => {
        if (result.error !== undefined) {
          setError(result.error);
        }
        if (result.plan !== undefined) {
          setPlan(result.plan);
          void dataHost.call('improve.plans', repository).then(setPlans).catch(() => undefined);
        }
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setGenerating(false));
  };

  const openPlan = (id: string): void => {
    void dataHost
      .call('improve.plan', id)
      .then((loaded) => setPlan(loaded))
      .catch(() => undefined);
  };

  const refreshPlan = useCallback(() => {
    if (plan !== undefined) {
      openPlan(plan.id);
      void dataHost.call('improve.plans', repository).then(setPlans).catch(() => undefined);
    }
  }, [plan, repository]);

  const selectionCount = pickedFiles.size + pickedSessions.size;
  const worstSessions = useMemo(() => (retro?.rows ?? []).slice(0, 15), [retro]);
  const topHotspots = useMemo(() => (hotspots?.rows ?? []).slice(0, 15), [hotspots]);

  /**
   * Why the generate button is disabled, when nothing else on the page already
   * says so (the gate banner, the repo-status banner, and the backend note
   * each explain their own case). A mutely disabled button is a dead end.
   */
  const disabledReason = ((): string | undefined => {
    if (generating || repository === '') {
      return undefined;
    }
    if (enabled === undefined) {
      return 'Could not read the Settings toggle — if you are running a dev build started before this feature, restart the app so the data host picks it up.';
    }
    if (enabled !== true || status?.error !== undefined || (backend !== undefined && !backend.available)) {
      return undefined; // the banner / backend note already explains
    }
    if (status === undefined) {
      return 'Checking the repository checkout…';
    }
    if (backend === undefined) {
      return 'Checking the AI backend…';
    }
    if (selectionCount === 0) {
      return 'Select at least one context file or session above.';
    }
    return undefined;
  })();

  return (
    <div className="improve">
      <header className="improve-header">
        <h1>Improve</h1>
        <p>
          Pick a repository&apos;s busiest context files and roughest sessions, and get a concrete
          plan for how its CLAUDE.md, AGENTS.md, and instruction files should change — written by
          your own {backend?.label ?? 'AI'} CLI, applied only with your per-file approval.
        </p>
        <label className="improve-repo">
          Repository
          <select
            value={repository}
            disabled={reposLoading}
            onChange={(e) => setRepository(e.target.value)}
          >
            <option value="">{reposLoading ? 'Loading repositories…' : 'Pick a repository…'}</option>
            {repositories.map((repo) => (
              <option key={repo} value={repo}>
                {repo}
              </option>
            ))}
          </select>
        </label>
      </header>

      {enabled === false && (
        <div className="improve-banner" role="alert">
          Context improvement plans are turned off. Enable them under{' '}
          <strong>Settings → Analysis</strong> first — generating a plan sends the selected
          evidence and the repository&apos;s context files to {backend?.vendor ?? 'the AI vendor'}{' '}
          through your own CLI login.
        </div>
      )}

      {repository === '' ? (
        reposLoading ? (
          <div className="detail-loading" role="status" aria-live="polite">
            <Spinner size={36} stroke={3} />
            <p className="detail-loading-title">Finding repositories…</p>
          </div>
        ) : (
          <div className="placeholder">
            <div>
              <h2>Pick a repository</h2>
              <p>
                The selection lists fill from what the analysis has already read: the context files
                agents load there, and the sessions that struggled.
              </p>
            </div>
          </div>
        )
      ) : (
        <>
          {status?.error !== undefined && (
            <div className="improve-banner" role="alert">
              {status.error}
            </div>
          )}

          <div className="improve-columns">
            <section className="card">
              <div className="card-head">
                <h2>Context files</h2>
                <span className="card-note">
                  {pickedFiles.size} of {MAX_IMPROVE_HOTSPOTS} selected
                </span>
              </div>
              {topHotspots.length === 0 ? (
                <p className="chart-empty">No context files seen in this repository yet.</p>
              ) : (
                <ul className="improve-list">
                  {topHotspots.map((row) => (
                    <li key={row.file}>
                      <label title={row.file}>
                        <input
                          type="checkbox"
                          checked={pickedFiles.has(row.file)}
                          onChange={() => toggleFile(row.file)}
                        />
                        <span className="improve-list-name">{shortPath(row.file)}</span>
                        <span className="improve-list-meta">
                          {categoryLabel(row.category)} · {row.sessionCount} sessions ·{' '}
                          {row.skippedCount} skipped
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="card">
              <div className="card-head">
                <h2>Sessions as evidence</h2>
                <span className="card-note">
                  {pickedSessions.size} of {MAX_IMPROVE_SESSIONS} selected
                </span>
              </div>
              {worstSessions.length === 0 ? (
                <p className="chart-empty">No judged sessions in this repository yet.</p>
              ) : (
                <ul className="improve-list">
                  {worstSessions.map((row) => {
                    const key = sessionKey(row.source, row.sessionId);
                    return (
                      <li key={key}>
                        <label>
                          <input
                            type="checkbox"
                            checked={pickedSessions.has(key)}
                            onChange={() => toggleSession(key)}
                          />
                          <span className={`retro-view-chip retro-view-chip-${row.verdict}`}>
                            {verdictLabel(row.verdict)}
                          </span>
                          <span className="improve-list-name">
                            {row.title ?? row.sessionId.slice(0, 8)}
                          </span>
                          <span className="improve-list-meta">{formatRelative(row.endedAtMs)}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>

          <div className="improve-actions">
            <button
              type="button"
              className="improve-generate"
              disabled={
                generating ||
                enabled !== true ||
                selectionCount === 0 ||
                status?.root === undefined ||
                backend?.available !== true
              }
              onClick={() => setConfirming(true)}
            >
              {generating ? 'Generating…' : 'Generate improvement plan'}
            </button>
            {generating && <Spinner size={18} stroke={2} />}
            {generating && (
              <span className="improve-note">
                Working through your own {backend?.label ?? 'AI'} CLI — this can take a couple of
                minutes.
              </span>
            )}
            {backend !== undefined && !backend.available && (
              <span className="improve-note">{backend.reason}</span>
            )}
            {disabledReason !== undefined && (
              <span className="improve-note" role="status">
                {disabledReason}
              </span>
            )}
          </div>

          {error !== undefined && (
            <div className="improve-banner" role="alert">
              {error}
            </div>
          )}

          {plan !== undefined && (
            <PlanCard plan={plan} onApply={setApplying} onRefresh={refreshPlan} />
          )}
          {plan !== undefined && runEnabled && (
            <button
              type="button"
              className="modal-btn"
              title="Opens Run with this plan as an editable goal. Nothing is sent until you press Start."
              onClick={() => openRunDoor({ door: 'improve-plan', planId: plan.id, repository: plan.repository })}
            >
              Apply this plan with an agent
            </button>
          )}

          {plans.length > 0 && (
            <section className="card">
              <div className="card-head">
                <h2>Earlier plans</h2>
              </div>
              <ul className="improve-history">
                {plans.map((row) => (
                  <li key={row.id}>
                    <button type="button" className="table-link" onClick={() => openPlan(row.id)}>
                      {formatRelative(row.createdAtMs)} · {row.backendLabel} ·{' '}
                      {row.summary ?? `${row.editCount} proposed edits`}
                      {row.appliedCount > 0 ? ` · ${row.appliedCount} applied` : ''}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {confirming && (
        <GenerateDialog
          backend={backend}
          fileCount={pickedFiles.size}
          sessionCount={pickedSessions.size}
          onCancel={() => setConfirming(false)}
          onConfirm={generate}
        />
      )}
      {applying !== undefined && plan !== undefined && (
        <ApplyDialog
          plan={plan}
          path={applying}
          onClose={() => {
            setApplying(undefined);
            refreshPlan();
          }}
        />
      )}
    </div>
  );
}

/** One generated plan: the narrative plus its proposed edits. */
function PlanCard({
  plan,
  onApply,
  onRefresh,
}: {
  plan: ContextPlanView;
  onApply: (path: string) => void;
  onRefresh: () => void;
}): JSX.Element {
  const [undoing, setUndoing] = useState(false);
  const undoFile = (path: string): void => {
    setUndoing(true);
    dataHost
      .call('improve.undo', plan.id, [path])
      .catch(() => undefined)
      .then(() => onRefresh())
      .finally(() => setUndoing(false));
  };

  return (
    <section className="card improve-plan">
      <div className="card-head">
        <h2>{plan.summary ?? 'Improvement plan'}</h2>
        <span className="card-note">
          {formatRelative(plan.createdAtMs)} · {plan.backendLabel}
        </span>
      </div>
      {/* Host-rendered markdown, the AssistantView pattern — never a renderer parser. */}
      <div className="improve-narrative" dangerouslySetInnerHTML={{ __html: plan.narrativeHtml }} />
      {plan.invalidEditCount > 0 && (
        <p className="improve-note">
          {plan.invalidEditCount === 1
            ? 'One proposal could not be validated and was dropped.'
            : `${plan.invalidEditCount} proposals could not be validated and were dropped.`}
        </p>
      )}
      {plan.edits.length > 0 && (
        <>
          <h3 className="improve-edits-title">Proposed file changes</h3>
          <ul className="improve-edits">
            {plan.edits.map((edit) => (
              <li key={edit.path}>
                <code>{edit.path}</code>
                <span className="improve-list-meta">
                  {edit.action === 'create' ? 'new file' : 'replace'}
                  {edit.rationale !== undefined ? ` — ${edit.rationale}` : ''}
                </span>
                {edit.appliedAtMs !== undefined && edit.revertedAtMs === undefined ? (
                  <>
                    <span className="improve-applied">Applied</span>
                    {edit.canUndo && (
                      <button
                        type="button"
                        className="improve-edit-btn"
                        disabled={undoing}
                        onClick={() => undoFile(edit.path)}
                      >
                        Undo
                      </button>
                    )}
                  </>
                ) : (
                  <button type="button" className="improve-edit-btn" onClick={() => onApply(edit.path)}>
                    Preview &amp; apply
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** Gate 2: the per-generation consent dialog, naming the vendor and the payload. */
function GenerateDialog({
  backend,
  fileCount,
  sessionCount,
  onCancel,
  onConfirm,
}: {
  backend?: AiBackendInfo;
  fileCount: number;
  sessionCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelRef.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="improve-generate-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="improve-generate-title">Generate an improvement plan?</h2>
        <p>
          This sends, to <strong>{backend?.vendor ?? 'the AI vendor'}</strong> through your own{' '}
          {backend?.label ?? 'AI'} CLI login:
        </p>
        <ul>
          <li>usage statistics for the {fileCount} selected context files,</li>
          <li>
            the retrospective evidence of the {sessionCount} selected sessions — titles, goals,
            findings, and any stored deep retrospectives,
          </li>
          <li>
            the <strong>contents</strong> of the repository&apos;s context files (capped at 24
            files / 48k characters).
          </li>
        </ul>
        <p>
          Nothing runs in the background, nothing touches the cloud-sync path, and the plan is
          stored only on this machine. No file is changed without your per-file approval.
        </p>
        <div className="modal-actions">
          <button ref={cancelRef} type="button" className="modal-btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="modal-btn" onClick={onConfirm}>
            Send and generate
          </button>
        </div>
      </div>
    </div>
  );
}

/** Per-file diff preview + apply. The diff is live: it doubles as the staleness probe. */
function ApplyDialog({
  plan,
  path,
  onClose,
}: {
  plan: ContextPlanView;
  path: string;
  onClose: () => void;
}): JSX.Element {
  const [diff, setDiff] = useState<FileDiffResult | undefined>(undefined);
  const [result, setResult] = useState<ApplyResult | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void dataHost
      .call('improve.diff', plan.id, path)
      .then(setDiff)
      .catch((err: Error) => setDiff({ lines: [], stale: false, missing: false, error: err.message }));
  }, [plan.id, path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const apply = (): void => {
    setBusy(true);
    dataHost
      .call('improve.apply', plan.id, [path])
      .then(setResult)
      .catch((err: Error) => setResult({ results: [], error: err.message }))
      .finally(() => setBusy(false));
  };

  const fileResult = result?.results.find((r) => r.path === path);
  const blocked = diff === undefined || diff.stale || diff.missing || diff.error !== undefined;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal improve-apply-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="improve-apply-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="improve-apply-title">
          <code>{path}</code>
        </h2>
        {diff === undefined ? (
          <p>Reading the file…</p>
        ) : diff.error !== undefined ? (
          <div className="modal-warning" role="alert">
            <p>{diff.error}</p>
          </div>
        ) : (
          <>
            {diff.stale && (
              <div className="modal-warning" role="alert">
                <p>
                  This file changed since the plan was generated — applying is disabled. Regenerate
                  the plan to propose against the current content.
                </p>
              </div>
            )}
            <div className="improve-diff" role="region" aria-label="Proposed change">
              {diff.lines.map((line, index) =>
                line.kind === 'fold' ? (
                  <div key={index} className="improve-diff-fold">
                    ⋯ {line.count} unchanged lines
                  </div>
                ) : (
                  <div key={index} className={`improve-diff-line improve-diff-${line.kind}`}>
                    <span className="improve-diff-sign">
                      {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
                    </span>
                    {line.text}
                  </div>
                ),
              )}
            </div>
          </>
        )}
        {fileResult !== undefined && (
          <p className={fileResult.ok ? 'improve-note' : 'improve-error'} role="status">
            {fileResult.ok ? 'Applied.' : fileResult.detail ?? fileResult.status}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="modal-btn" onClick={onClose}>
            Close
          </button>
          {fileResult?.ok !== true && (
            <button type="button" className="modal-btn" disabled={busy || blocked} onClick={apply}>
              Apply this file
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
