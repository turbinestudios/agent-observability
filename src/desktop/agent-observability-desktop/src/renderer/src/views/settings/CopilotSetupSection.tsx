import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { COPILOT_TRACE_SETTING } from '../../../../shared/rpc';
import type { CopilotSetupStatus, CopilotSetupTarget } from '../../../../shared/rpc';
import { dataHost } from '../../api/client';

/**
 * Per-editor status of the Copilot trace-exporter setting, with the one-click
 * fix. This is the permanent home of the setup flow — the startup prompt can
 * be dismissed forever, so everything it offers must remain reachable here.
 *
 * Rendered inside the Copilot "nothing found" explanation. When the datahost
 * has no editor to act on (or the status cannot be loaded), the old manual
 * instructions render instead, so no machine is left without a path forward.
 */
export function CopilotSetupSection({ onRecheck }: { onRecheck: () => void }): JSX.Element | null {
  const [status, setStatus] = useState<CopilotSetupStatus | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [justEnabled, setJustEnabled] = useState(false);
  /** Write failures by settings file, layered over the re-checked status. */
  const [writeErrors, setWriteErrors] = useState<ReadonlyMap<string, string>>(new Map());

  const refresh = useCallback(() => {
    dataHost
      .call('copilot.setupStatus')
      .then((next) => {
        setStatus(next);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const enable = (settingsFiles: string[]): void => {
    setBusy(true);
    dataHost
      .call('copilot.enableTracing', settingsFiles)
      .then((result) => {
        setStatus(result.status);
        setWriteErrors(
          new Map(result.results.filter((r) => !r.ok).map((r) => [r.settingsFile, r.detail])),
        );
        if (result.results.some((r) => r.ok)) {
          setJustEnabled(true);
        }
      })
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  };

  if (status === undefined && !failed) {
    return null; // One RPC round-trip; flashing fallback text first would mislead.
  }

  if (failed || status === undefined || status.targets.length === 0) {
    return <ManualInstructions />;
  }

  return (
    <div className="settings-setup">
      <ul className="settings-setup-list">
        {status.targets.map((target) => (
          <SetupRow
            key={target.settingsFile}
            target={target}
            busy={busy}
            writeError={writeErrors.get(target.settingsFile)}
            onEnable={() => enable([target.settingsFile])}
          />
        ))}
      </ul>
      {justEnabled && (
        <p className="settings-setup-restart">
          <strong>One more step:</strong> fully quit and restart VS Code (Quit, not just the
          window), chat with Copilot once, then press Check again.
        </p>
      )}
      <button
        type="button"
        className="settings-action"
        disabled={busy}
        onClick={() => {
          refresh();
          onRecheck();
          void dataHost.call('index.refresh').catch(() => undefined);
        }}
      >
        Check again
      </button>
    </div>
  );
}

function SetupRow({
  target,
  busy,
  writeError,
  onEnable,
}: {
  target: CopilotSetupTarget;
  busy: boolean;
  writeError: string | undefined;
  onEnable: () => void;
}): JSX.Element {
  const fixable =
    target.state === 'unset' || target.state === 'disabled' || target.state === 'no-settings-file';
  return (
    <li className="settings-setup-row">
      <div className="settings-setup-main">
        <span className="settings-setup-name">{target.variantLabel}</span>
        <span className={`settings-setup-state${target.state === 'enabled' ? ' is-on' : ''}`}>
          {describeState(target)}
        </span>
        {writeError !== undefined && (
          <span className="settings-warning">Could not write the setting: {writeError}</span>
        )}
        {(target.state === 'unparseable' || target.state === 'denied' || writeError !== undefined) && (
          <span className="settings-setup-manual">
            {target.detail !== undefined && writeError === undefined && (
              <span className="settings-warning">{target.detail}. </span>
            )}
            Add <code>&quot;{COPILOT_TRACE_SETTING}&quot;: true</code> yourself:
            <button
              type="button"
              className="settings-action settings-action-inline"
              onClick={() => void window.desktop.openPath(target.settingsFile)}
            >
              Open settings.json
            </button>
          </span>
        )}
      </div>
      {fixable && writeError === undefined && (
        <button
          type="button"
          className="settings-action settings-action-inline"
          disabled={busy}
          onClick={onEnable}
        >
          Enable
        </button>
      )}
    </li>
  );
}

function describeState(target: CopilotSetupTarget): string {
  switch (target.state) {
    case 'enabled':
      return target.dbExists
        ? 'Tracing on'
        : 'Tracing on — waiting for the first Copilot chat after a restart';
    case 'disabled':
      return 'Tracing switched off in this editor’s settings';
    case 'unset':
      return 'Tracing off (the editor’s default)';
    case 'no-settings-file':
      return 'No settings file yet — enabling will create one';
    case 'unparseable':
      return 'Its settings.json could not be read';
    case 'denied':
      return 'Its settings.json is not accessible';
  }
}

/** The pre-1.10 hand-edit instructions, kept as the no-targets fallback. */
function ManualInstructions(): JSX.Element {
  return (
    <p>
      Add <code>&quot;{COPILOT_TRACE_SETTING}&quot;: true</code> to your VS Code settings, chat
      with Copilot once, then refresh.
    </p>
  );
}
