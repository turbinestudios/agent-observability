import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { COPILOT_TRACE_SETTING } from '../../../shared/rpc';
import type { CopilotSetupStatus, EnableTracingTargetResult } from '../../../shared/rpc';
import { dataHost } from '../api/client';
import { fixableTargets } from './copilotSetupState';

/**
 * The startup offer to switch Copilot tracing on.
 *
 * VS Code records Copilot agent sessions only while the trace exporter is on,
 * and it is off by default — so a first launch on most machines has nothing to
 * show and a one-click way to change that. The dialog appears once per
 * machine: any dismissal is persisted, and the Settings page keeps the same
 * fix available forever after.
 *
 * Deliberately escapable (Not now, Escape, the backdrop), and never shown over
 * another blocking overlay — the shell decides that via
 * `copilotSetupDialogState` (in ./copilotSetupState, kept import-pure for the
 * node-only tests), following the update dialog's pattern.
 */

type Phase =
  | { kind: 'offer'; busy: boolean }
  | { kind: 'finished'; failures: EnableTracingTargetResult[] };

export function CopilotSetupDialog({
  status,
  onDismiss,
}: {
  status: CopilotSetupStatus;
  onDismiss: () => void;
}): JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: 'offer', busy: false });
  const primaryRef = useRef<HTMLButtonElement>(null);
  const fixable = fixableTargets(status);

  useEffect(() => primaryRef.current?.focus(), []);

  // Every way out persists the dismissal: the prompt is a once-per-machine
  // offer, and the Settings page remains the permanent surface. (After a
  // successful enable the persisted flag is moot anyway — an enabled editor
  // suppresses the prompt on its own.)
  const dismiss = (): void => {
    void dataHost.call('copilot.dismissSetupPrompt').catch(() => undefined);
    onDismiss();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        dismiss();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  const enable = (): void => {
    setPhase({ kind: 'offer', busy: true });
    dataHost
      .call(
        'copilot.enableTracing',
        fixable.map((t) => t.settingsFile),
      )
      .then((result) => setPhase({ kind: 'finished', failures: result.results.filter((r) => !r.ok) }))
      .catch((err: Error) =>
        setPhase({
          kind: 'finished',
          failures: [{ settingsFile: '', ok: false, detail: err.message }],
        }),
      );
  };

  return (
    <div className="modal-backdrop" onMouseDown={dismiss}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="copilot-setup-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {phase.kind === 'offer' ? (
          <>
            <h2 id="copilot-setup-title">See your Copilot sessions here</h2>
            <p className="setup-dialog-text">
              VS Code records Copilot agent sessions only while Copilot Chat&apos;s trace exporter
              is switched on — and it is off by default, so right now there is nothing for this app
              to read.
            </p>
            <p className="setup-dialog-text">
              This app can switch it on for you: one setting, added to{' '}
              {fixable.map((t) => t.variantLabel).join(', ')} on this machine. Nothing leaves your
              computer.
            </p>
            <div className="modal-actions">
              <button type="button" className="modal-btn" disabled={phase.busy} onClick={dismiss}>
                Not now
              </button>
              <button
                ref={primaryRef}
                type="button"
                className="modal-btn primary"
                disabled={phase.busy}
                onClick={enable}
              >
                {phase.busy ? 'Enabling…' : 'Enable Copilot tracing'}
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 id="copilot-setup-title">
              {phase.failures.length === 0 ? 'Copilot tracing is on' : 'Almost there'}
            </h2>
            {phase.failures.length < fixable.length && (
              <p className="setup-dialog-text">
                <strong>One more step:</strong> fully quit and restart VS Code (Quit, not just the
                window), then chat with Copilot once. Sessions appear here on the next refresh.
              </p>
            )}
            {phase.failures.map((failure) => (
              <p className="setup-dialog-text setup-dialog-failure" key={failure.settingsFile}>
                {failure.settingsFile === '' ? (
                  <>The setting could not be written: {failure.detail}</>
                ) : (
                  <>
                    <code>{failure.settingsFile}</code> could not be updated ({failure.detail}).
                    Add <code>&quot;{COPILOT_TRACE_SETTING}&quot;: true</code> to it yourself —{' '}
                    <button
                      type="button"
                      className="modal-btn setup-dialog-open"
                      onClick={() => void window.desktop.openPath(failure.settingsFile)}
                    >
                      Open settings.json
                    </button>
                  </>
                )}
              </p>
            ))}
            <div className="modal-actions">
              <button type="button" className="modal-btn" onClick={dismiss}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
