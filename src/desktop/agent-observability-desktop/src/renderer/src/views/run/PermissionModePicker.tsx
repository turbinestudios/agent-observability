import type { JSX } from 'react';
import { useState } from 'react';
import type { RunPermissionMode } from '../../../../shared/rpc';
import { ALLOW_ALL_WARNING, PERMISSION_MODE_OPTIONS } from './run';

/**
 * How one session treats the agent's requests: ask before each action (the
 * default), or Allow all.
 *
 * Allow all is never one click. Picking it opens a short warning in place and
 * only **Turn on Allow all** applies it; picking Default permissions applies
 * at once, because asking is always the safe direction. The choice belongs to
 * one session and is not remembered: the caller starts every new session on
 * the default.
 *
 * Renders two siblings so it can sit in a wrapping row: the labelled select,
 * and (while confirming) a full-width warning that wraps under the row.
 */
export function PermissionModePicker({
  mode,
  onChange,
  disabled = false,
}: {
  mode: RunPermissionMode;
  onChange: (next: RunPermissionMode) => void;
  disabled?: boolean;
}): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const asking = confirming && mode !== 'allow-all';
  return (
    <>
      <label className="run-mode">
        Permissions
        <select
          className={mode === 'allow-all' ? 'settings-input settings-select run-mode-all' : 'settings-input settings-select'}
          value={asking ? 'allow-all' : mode}
          disabled={disabled}
          onChange={(e) => {
            if (e.target.value === 'allow-all') {
              setConfirming(true);
            } else {
              setConfirming(false);
              if (mode !== 'default') {
                onChange('default');
              }
            }
          }}
        >
          {PERMISSION_MODE_OPTIONS.map((option) => (
            <option key={option.mode} value={option.mode}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {asking && (
        <div className="run-mode-confirm" role="alertdialog" aria-label="Turn on Allow all">
          <p>{ALLOW_ALL_WARNING}</p>
          <div className="modal-actions">
            <button type="button" className="modal-btn" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="modal-btn primary"
              onClick={() => {
                setConfirming(false);
                onChange('allow-all');
              }}
            >
              Turn on Allow all
            </button>
          </div>
        </div>
      )}
    </>
  );
}
