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
import type { AiAvailability, SettingsSnapshot } from '../../../../shared/rpc';
import { dataHost } from '../../api/client';
import { Spinner } from '../../components/Spinner';
import { CopilotSetupSection } from './CopilotSetupSection';
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

  const checkAvailability = useCallback(() => {
    dataHost
      .call('ai.availability')
      .then(setAvailability)
      .catch((err: Error) => setAvailability({ available: false, reason: err.message }));
  }, []);

  // Re-probed when the AI settings change: a corrected CLI path should clear
  // the warning without leaving the page.
  useEffect(() => {
    checkAvailability();
  }, [checkAvailability, snapshot?.claudeCliPath]);

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
          {snapshot.sqlitePath !== '' && snapshot.resolvedCopilotDbs[0]?.kind === 'archive' && (
            <span className="settings-warning">
              A durable Copilot archive exists and takes precedence — the override applies only when
              no archive is present.
            </span>
          )}
          <CopilotResolution snapshot={snapshot} onRecheck={() => save({})} />
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
          it sends that session's prompts and responses to Anthropic through your own Claude Code
          login — never in the background, and each run asks you to confirm first. Everything else
          in this app stays on this machine.
        </p>
      </section>

      <section className="settings-card" aria-label="AI">
        <h2>AI</h2>
        <p className="settings-hint">
          The AI Helper and the deep retrospective run through your own Claude Code CLI login on
          this machine — no API key of this app is involved.
        </p>
        {availability !== undefined && !availability.available && (
          <div className="settings-warning-block" role="alert">
            <p>
              <strong>The Claude Code CLI was not found.</strong> The AI Helper and the deep
              retrospective need it. Install it with{' '}
              <code>npm install -g @anthropic-ai/claude-code</code>, or set the path below.
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
          <span className="settings-label">Model</span>
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
          <span className="settings-label">Reasoning effort</span>
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
