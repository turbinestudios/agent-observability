import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
// From the parser rather than `Configuration`: the class pulls the whole
// settings surface — sync policy, chat backends — into the renderer bundle for
// the sake of one number.
import { MIN_SESSION_MINUTES } from '@agent-observability/core/src/config/workflowParsing';
// Pure constants (no node imports), safe for the renderer bundle.
import {
  CLAUDE_EFFORT_LEVELS,
  CLAUDE_MODEL_CHOICES,
} from '@agent-observability/core/src/chat/backends/claudeCliArgs';
import type { AiAvailability, AiBackendInfo, SettingsSnapshot } from '../../../../shared/rpc';
import { dataHost } from '../../api/client';
import { Spinner } from '../../components/Spinner';
import { CopilotSetupSection } from './CopilotSetupSection';
import { TeamConsentDialog } from '../team/TeamConsentDialog';
import { TeamPreviewDialog } from '../team/TeamPreviewDialog';
import '../team/team.css';
import { useSettings } from './useSettings';
import './settings.css';

/**
 * The desktop's settings: which sources are read and from where.
 *
 * Nothing here is required — every value auto-detects — so the page's job is
 * recovery and transparency: show what auto-detection resolved to, and give the
 * override a home when it resolved wrong. Changes persist to the config file
 * and re-index immediately; there is no save button and no restart.
 */

export function SettingsView(): JSX.Element {
  const { snapshot, error, saving, save } = useSettings();
  const [availability, setAvailability] = useState<AiAvailability | undefined>(undefined);
  const [backends, setBackends] = useState<AiBackendInfo[] | undefined>(undefined);
  // The team consent gate and the preview, both overlays of this page.
  const [teamConsentOpen, setTeamConsentOpen] = useState(false);
  const [teamPreviewOpen, setTeamPreviewOpen] = useState(false);

  const checkAvailability = useCallback(() => {
    dataHost
      .call('ai.availability')
      .then(setAvailability)
      .catch((err: Error) => setAvailability({ available: false, reason: err.message }));
    dataHost
      .call('ai.backends')
      .then(setBackends)
      .catch(() => setBackends(undefined));
  }, []);

  // Re-probed when the AI settings change: a corrected CLI path or a switched
  // backend should clear the warning without leaving the page.
  useEffect(() => {
    checkAvailability();
  }, [checkAvailability, snapshot?.claudeCliPath, snapshot?.copilotCliPath, snapshot?.aiBackend]);

  if (snapshot === undefined) {
    return error !== undefined ? (
      <div className="placeholder">
        <div>
          <h2>Could not load settings</h2>
          <p>{error}</p>
        </div>
      </div>
    ) : (
      <div className="detail-loading" role="status" aria-live="polite">
        <Spinner size={36} stroke={3} />
        <p className="detail-loading-title">Reading settings…</p>
      </div>
    );
  }

  return (
    <div className="settings">
      <header className="settings-header">
        <h1>Settings</h1>
        <p>
          Changes apply immediately — sources are re-scanned when they change. Stored in{' '}
          <code>{snapshot.configPath}</code>.
        </p>
      </header>

      {error !== undefined && <div className="settings-error">{error}</div>}

      <section className="settings-card" aria-label="Sources">
        <h2>Sources</h2>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={snapshot.claudeEnabled}
            disabled={saving}
            onChange={(e) => save({ claudeEnabled: e.target.checked })}
          />
          Claude Code
        </label>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={snapshot.copilotEnabled}
            disabled={saving}
            onChange={(e) => save({ copilotEnabled: e.target.checked })}
          />
          GitHub Copilot
        </label>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={snapshot.copilotCliEnabled}
            disabled={saving}
            onChange={(e) => save({ copilotCliEnabled: e.target.checked })}
          />
          GitHub Copilot CLI
        </label>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={snapshot.copilotAppEnabled}
            disabled={saving}
            onChange={(e) => save({ copilotAppEnabled: e.target.checked })}
          />
          GitHub Copilot app
        </label>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={snapshot.copilotJetbrainsEnabled}
            disabled={saving}
            onChange={(e) => save({ copilotJetbrainsEnabled: e.target.checked })}
          />
          GitHub Copilot in JetBrains IDEs (Rider, IntelliJ IDEA, …)
        </label>
        <p className="settings-hint">
          Turning a source off removes its sessions from the list; turning it back on re-reads them.
        </p>
      </section>

      <section className="settings-card" aria-label="Paths">
        <h2>Paths</h2>

        <div className="settings-row">
          <span className="settings-label">Claude Code projects folder</span>
          <PathInput
            value={snapshot.claudeProjectsPath}
            disabled={saving}
            ariaLabel="Claude Code projects folder"
            onCommit={(value) => save({ claudeProjectsPath: value })}
          />
          {snapshot.claudeOverrideMissing && (
            <span className="settings-warning">
              This folder does not exist — the default locations are still scanned.
            </span>
          )}
          <span className="settings-resolved">{describeClaudeResolution(snapshot)}</span>
        </div>

        <div className="settings-row">
          <span className="settings-label">Copilot database</span>
          <PathInput
            value={snapshot.sqlitePath}
            disabled={saving}
            ariaLabel="Copilot database"
            onCommit={(value) => save({ sqlitePath: value })}
          />
          {snapshot.sqliteOverrideMissing && (
            <span className="settings-warning">This file does not exist.</span>
          )}
          {snapshot.sqlitePath !== '' && snapshot.resolvedCopilotDbs[0]?.kind === 'archive' && (
            <span className="settings-warning">
              A durable Copilot archive exists and takes precedence — the override applies only when
              no archive is present.
            </span>
          )}
          <CopilotResolution snapshot={snapshot} onRecheck={() => save({})} />
        </div>

        <div className="settings-row">
          <span className="settings-label">Copilot for JetBrains chat folder</span>
          <PathInput
            value={snapshot.copilotJetbrainsStorePath}
            disabled={saving}
            ariaLabel="Copilot for JetBrains chat folder"
            onCommit={(value) => save({ copilotJetbrainsStorePath: value })}
          />
          <span className="settings-resolved">{describeJetbrainsResolution(snapshot)}</span>
        </div>
      </section>

      <section className="settings-card" aria-label="Analysis">
        <h2>Analysis</h2>
        <div className="settings-row">
          <span className="settings-label">Flag a turn longer than</span>
          <MinutesInput
            value={snapshot.maxSessionMinutes}
            disabled={saving}
            onCommit={(value) => save({ maxSessionMinutes: value })}
          />
          <span className="settings-resolved">
            Sessions are also flagged when a turn's tool calls fail more often than they succeed.
            Only the most recent sessions are analyzed, in the background.
          </span>
        </div>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={snapshot.deepRetroEnabled}
            disabled={saving}
            onChange={(e) => save({ deepRetroEnabled: e.target.checked })}
          />
          Allow the deep retrospective
        </label>
        <p className="settings-hint">
          Adds an "Ask for a deep retrospective" button to a session's retrospective card. Running
          it sends that session's prompts and responses to the vendor of your selected AI backend —
          Anthropic through your own Claude Code login, or GitHub through your own Copilot CLI
          login — never in the background, and each run asks you to confirm first. Everything else
          in this app stays on this machine.
        </p>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={snapshot.improveEnabled}
            disabled={saving}
            onChange={(e) => save({ improveEnabled: e.target.checked })}
          />
          Allow context improvement plans
        </label>
        <p className="settings-hint">
          Lets the Improve view generate plans for a repository's context files. Generating one
          sends the selected files' usage statistics, the selected sessions' retrospective
          evidence, and the repository's context-file contents to your selected AI backend's
          vendor — each generation asks you to confirm first, and no file is ever changed without
          your per-file approval.
        </p>
      </section>

      <section className="settings-card" aria-label="Run">
        <h2>Run</h2>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={snapshot.runEnabled}
            disabled={saving}
            onChange={(e) => save({ runEnabled: e.target.checked })}
          />
          Run Copilot sessions from this app
        </label>
        <p className="settings-hint">
          Off by default. When on, a Run view lets you start or continue a GitHub Copilot session here. It uses your
          own installed <code>copilot</code> and your own Copilot login, and sends your message and whatever the agent
          then reads to GitHub, exactly as running it in a terminal does. Every action asks you first, unless you pick
          Allow all for a session. Claude Code
          sessions are never run from here; they are resumed in your own terminal.
        </p>
        <div className="settings-row">
          <span className="settings-label">Default model</span>
          <input
            className="settings-input"
            defaultValue={snapshot.runDefaultModel}
            placeholder="The CLI's own default"
            disabled={saving || !snapshot.runEnabled}
            onBlur={(e) => save({ runDefaultModel: e.target.value })}
          />
        </div>
        <p className="settings-hint">
          Copilot CLI:{' '}
          {backends?.find((b) => b.id === 'copilot-cli')?.available === true
            ? 'found'
            : 'not found yet. Set its path under AI below, or install it.'}
        </p>
      </section>

      <section className="settings-card" aria-label="Workspace">
        <h2>Workspace</h2>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={snapshot.liveNotifications}
            disabled={saving}
            onChange={(e) => save({ liveNotifications: e.target.checked })}
          />
          Notify me when a live session is waiting for me or has finished
        </label>
        <p className="settings-hint">
          Shown by this computer only. The notification names the session using the title from your local logs;
          nothing is sent anywhere. Status comes from the end of each session&apos;s own log, so a tool call waiting
          for your approval can look like a running one until it has been pending a while.
        </p>
      </section>

      <section className="settings-card" aria-label="Team">
        <h2>Team</h2>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={snapshot.teamEnabled}
            disabled={saving}
            onChange={(e) => save({ teamEnabled: e.target.checked })}
          />
          Show the Team view
        </label>
        <p className="settings-hint">
          Off by default. When on, a Team view shows how your team uses agents through a folder you already share
          (OneDrive, SharePoint, a network drive). Each member&apos;s app writes one file there with counts and
          totals under an anonymous id, and reads everyone else&apos;s. No server, no account. Turning this off
          also stops sharing.
        </p>
        {snapshot.teamEnabled && (
          <>
            <div className="settings-row">
              <span className="settings-label">Team folder</span>
              <div className="team-folder-row">
                <code>{snapshot.teamFolder.length > 0 ? snapshot.teamFolder : 'Not chosen'}</code>
                <button
                  type="button"
                  className="settings-action settings-action-inline"
                  disabled={saving}
                  onClick={() =>
                    void window.desktop
                      .pickFolder()
                      .then((folder) => {
                        if (folder !== undefined) {
                          save({ teamFolder: folder });
                        }
                      })
                      .catch(() => undefined)
                  }
                >
                  Choose…
                </button>
                {snapshot.teamFolder.length > 0 && (
                  <button
                    type="button"
                    className="settings-action settings-action-inline"
                    disabled={saving}
                    onClick={() => save({ teamFolder: '' })}
                  >
                    Clear
                  </button>
                )}
              </div>
              {snapshot.teamFolder.length > 0 && !snapshot.teamFolderExists && (
                <p className="settings-hint">This folder does not exist right now.</p>
              )}
            </div>
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={snapshot.teamShareEnabled}
                disabled={saving || snapshot.teamFolder.length === 0}
                onChange={(e) => {
                  if (e.target.checked) {
                    setTeamConsentOpen(true);
                  } else {
                    save({ teamShareEnabled: false });
                  }
                }}
              />
              Share my aggregates with the team folder
            </label>
            {snapshot.teamFolder.length === 0 && (
              <p className="settings-hint">Choose a team folder first.</p>
            )}
            <label className="settings-toggle">
              <input
                type="checkbox"
                checked={snapshot.teamAutoExport}
                disabled={saving || !snapshot.teamShareEnabled}
                onChange={(e) => save({ teamAutoExport: e.target.checked })}
              />
              Export automatically every hour while the app runs
            </label>
            <button type="button" className="settings-action" onClick={() => setTeamPreviewOpen(true)}>
              Preview what will be shared
            </button>
            <p className="settings-hint">
              The folder is only read, never changed, apart from your own file; every file is checked against the
              format before it is merged.
            </p>
            <p className="settings-hint">
              Each install has its own anonymous id, so the same person on two computers counts twice.
            </p>
            <p className="settings-hint">
              Your anonymous id: <code>{snapshot.teamDeveloperId}</code>
            </p>
          </>
        )}
      </section>

      <section className="settings-card" aria-label="AI">
        <h2>AI</h2>
        <p className="settings-hint">
          The AI features run through your own AI CLI login on this machine — Claude Code (sends to
          Anthropic) or the GitHub Copilot CLI (sends to GitHub). No API key of this app is
          involved, and which one answers is your choice here.
        </p>
        <div className="settings-row">
          <span className="settings-label">AI backend</span>
          {AI_BACKEND_CHOICES.map((choice) => {
            const info = backends?.find((b) => b.id === choice.id);
            return (
              <label key={choice.id} className="settings-toggle">
                <input
                  type="radio"
                  name="ai-backend"
                  checked={snapshot.aiBackend === choice.id}
                  disabled={saving}
                  onChange={() => save({ aiBackend: choice.id })}
                />
                {choice.label}
                <span className="settings-resolved">
                  {' '}
                  — sends to {choice.vendor}
                  {info !== undefined && !info.available ? ' · CLI not found' : ''}
                </span>
              </label>
            );
          })}
        </div>
        {availability !== undefined && !availability.available && (
          <div className="settings-warning-block" role="alert">
            <p>
              <strong>The selected AI CLI is not working.</strong> {availability.reason}
            </p>
            <button type="button" className="settings-action" onClick={checkAvailability}>
              Check again
            </button>
          </div>
        )}
        <div className="settings-row">
          <span className="settings-label">Claude CLI path</span>
          <PathInput
            value={snapshot.claudeCliPath}
            disabled={saving}
            ariaLabel="Claude CLI path"
            onCommit={(value) => save({ claudeCliPath: value })}
          />
          <span className="settings-resolved">
            Leave empty to use <code>claude</code> from PATH.
          </span>
        </div>
        <div className="settings-row">
          <span className="settings-label">Copilot CLI path</span>
          <PathInput
            value={snapshot.copilotCliPath}
            disabled={saving}
            ariaLabel="Copilot CLI path"
            onCommit={(value) => save({ copilotCliPath: value })}
          />
          <span className="settings-resolved">
            Leave empty to use <code>copilot</code> from PATH.
          </span>
        </div>
        <div className="settings-row">
          <span className="settings-label">Claude model</span>
          <select
            className="settings-input settings-select"
            aria-label="Claude model for AI features"
            value={snapshot.claudeModel}
            disabled={saving}
            onChange={(e) => save({ claudeModel: e.target.value })}
          >
            {CLAUDE_MODEL_CHOICES.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ))}
            {!CLAUDE_MODEL_CHOICES.some((choice) => choice.id === snapshot.claudeModel) && (
              <option value={snapshot.claudeModel}>{snapshot.claudeModel}</option>
            )}
          </select>
        </div>
        <div className="settings-row">
          <span className="settings-label">Claude reasoning effort</span>
          <select
            className="settings-input settings-select"
            aria-label="Reasoning effort for AI features"
            value={snapshot.claudeEffort}
            disabled={saving}
            onChange={(e) => save({ claudeEffort: e.target.value })}
          >
            {CLAUDE_EFFORT_LEVELS.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="settings-card" aria-label="Configuration">
        <h2>Configuration</h2>
        <p className="settings-hint">
          Everything the app stores — settings, renames, hidden sessions, and the session index —
          lives in one folder.
        </p>
        <button
          type="button"
          className="settings-action"
          onClick={() => void window.desktop.openPath(snapshot.configDir)}
        >
          Open config folder
        </button>
      </section>

      {teamConsentOpen && (
        <TeamConsentDialog
          folder={snapshot.teamFolder}
          onCancel={() => setTeamConsentOpen(false)}
          onConfirm={(mode, repositories) => {
            setTeamConsentOpen(false);
            save({ teamShareEnabled: true, teamRepositoryMode: mode, teamRepositories: repositories });
          }}
        />
      )}
      {teamPreviewOpen && <TeamPreviewDialog onClose={() => setTeamPreviewOpen(false)} />}
    </div>
  );
}

/** The two CLIs the desktop can route AI features through, in display order. */
const AI_BACKEND_CHOICES: readonly {
  id: 'claude-code' | 'copilot-cli';
  label: string;
  vendor: string;
}[] = [
  { id: 'claude-code', label: 'Claude Code', vendor: 'Anthropic' },
  { id: 'copilot-cli', label: 'GitHub Copilot CLI', vendor: 'GitHub' },
];

/** What the Claude scan will actually read, given the current settings. */
function describeClaudeResolution(snapshot: SettingsSnapshot): string {
  if (!snapshot.claudeEnabled) {
    return 'Claude Code is turned off.';
  }
  if (snapshot.resolvedClaudeDirs.length === 0) {
    return 'No Claude Code projects folder found on this machine yet.';
  }
  return `Reading from: ${snapshot.resolvedClaudeDirs.join(' · ')}`;
}

/** Where the JetBrains reader looks, and which IDEs it found chat stores for. */
function describeJetbrainsResolution(snapshot: SettingsSnapshot): string {
  if (!snapshot.copilotJetbrainsEnabled) {
    return 'Copilot in JetBrains IDEs is turned off.';
  }
  const stores = snapshot.resolvedJetbrainsStores;
  if (stores.length === 0) {
    return `No Copilot chat stores found in ${snapshot.copilotJetbrainsRoot}.`;
  }
  const ides = [...new Set(stores.map((s) => s.ide))].sort().join(', ');
  return `Found ${stores.length} chat ${stores.length === 1 ? 'store' : 'stores'} (${ides}) in ${snapshot.copilotJetbrainsRoot}.`;
}

/**
 * Which Copilot databases the next index pass will read — and when none were
 * found, WHERE the app looked and what makes one appear. A first-time user who
 * only sees "not found" has no move to make; the scanned locations plus the
 * one-click fix (or its manual fallback) turn the dead end into a checklist.
 */
function CopilotResolution({
  snapshot,
  onRecheck,
}: {
  snapshot: SettingsSnapshot;
  onRecheck: () => void;
}): JSX.Element {
  if (!snapshot.copilotEnabled) {
    return <span className="settings-resolved">GitHub Copilot is turned off.</span>;
  }
  const dbs = snapshot.resolvedCopilotDbs;
  if (dbs.length === 0) {
    return (
      <div className="settings-resolved">
        <p>No Copilot database found yet. These locations were checked:</p>
        <ul className="settings-scanned">
          {snapshot.copilotScannedPaths.map((p) => (
            <li key={p}>
              <code>{p}</code>
            </li>
          ))}
        </ul>
        <p>
          VS Code writes this file only while Copilot Chat&apos;s trace exporter is switched on,
          and it is off by default — which is why a machine that uses Copilot every day can still
          have no database.
        </p>
        <CopilotSetupSection onRecheck={onRecheck} />
        <p>
          Editors built on VS Code (Cursor, VSCodium, …) are scanned automatically too. If yours
          keeps its data somewhere else entirely, point the field above at its{' '}
          <code>agent-traces.db</code>.
        </p>
      </div>
    );
  }
  return (
    <span className="settings-resolved">
      Reading from: {dbs.map((db) => `${db.path} (${describeDbKind(db.kind)})`).join(' · ')}
    </span>
  );
}

function describeDbKind(kind: 'archive' | 'native' | 'override'): string {
  return kind === 'archive' ? 'durable archive' : kind === 'override' ? 'override' : 'VS Code storage';
}

/**
 * The turn-duration threshold, in minutes. Commits on blur or Enter and reverts
 * on Escape, like the path fields; an unusable value reverts rather than being
 * saved, since the data host would only clamp it back and the page would appear
 * to ignore what was typed.
 */
function MinutesInput({
  value,
  disabled,
  onCommit,
}: {
  value: number;
  disabled: boolean;
  onCommit: (value: number) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = (): void => {
    const next = Number(draft.trim());
    if (!Number.isFinite(next) || next < MIN_SESSION_MINUTES) {
      setDraft(String(value));
      return;
    }
    if (Math.floor(next) !== value) {
      onCommit(Math.floor(next));
    }
  };

  return (
    <div className="settings-inline">
      <input
        className="settings-input settings-input-narrow"
        type="number"
        min={MIN_SESSION_MINUTES}
        value={draft}
        aria-label="Flag a turn longer than, in minutes"
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            setDraft(String(value));
          }
        }}
      />
      <span className="settings-unit">minutes</span>
    </div>
  );
}

/**
 * A path override field. Commits on blur or Enter, reverts on Escape, and shows
 * "Auto-detect" while empty — an empty commit clears the override.
 */
function PathInput({
  value,
  disabled,
  ariaLabel,
  onCommit,
}: {
  value: string;
  disabled: boolean;
  ariaLabel: string;
  onCommit: (value: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useState(value);

  // A save round-trip may normalize the value (trimming); follow it.
  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = (): void => {
    if (draft.trim() !== value) {
      onCommit(draft);
    }
  };

  return (
    <input
      className="settings-input"
      type="text"
      value={draft}
      placeholder="Auto-detect"
      aria-label={ariaLabel}
      disabled={disabled}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          setDraft(value);
        }
      }}
    />
  );
}
