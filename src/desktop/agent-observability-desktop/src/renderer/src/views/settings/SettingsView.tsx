import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import type { SettingsSnapshot } from '../../../../shared/rpc';
import { Spinner } from '../../components/Spinner';
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
          {snapshot.sqlitePath !== '' && snapshot.resolvedCopilotDb?.kind === 'archive' && (
            <span className="settings-warning">
              A durable Copilot archive exists and takes precedence — the override applies only when
              no archive is present.
            </span>
          )}
          <span className="settings-resolved">{describeCopilotResolution(snapshot)}</span>
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
    </div>
  );
}

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

/** Which Copilot database the next index pass would open. */
function describeCopilotResolution(snapshot: SettingsSnapshot): string {
  if (!snapshot.copilotEnabled) {
    return 'GitHub Copilot is turned off.';
  }
  const db = snapshot.resolvedCopilotDb;
  if (db === undefined) {
    return 'No Copilot database found on this machine.';
  }
  const kind =
    db.kind === 'archive' ? 'durable archive' : db.kind === 'override' ? 'override' : 'VS Code storage';
  return `Reading from: ${db.path} (${kind})`;
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
