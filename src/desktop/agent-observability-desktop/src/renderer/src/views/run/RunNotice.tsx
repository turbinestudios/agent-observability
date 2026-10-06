import type { JSX } from 'react';

/**
 * The one-time notice that gates Run. It says who receives what, in plain
 * words, before the first message can be sent. Accepting it is recorded by
 * the data host, which refuses every Run action until then.
 */
export function RunNotice({ onAccept, error }: { onAccept: () => void; error?: string }): JSX.Element {
  return (
    <div className="run-notice" role="region" aria-label="Before you start">
      <h2>Before you start a session here</h2>
      <ul>
        <li>
          A session you start here is a <strong>GitHub Copilot</strong> session. It uses your own Copilot login and
          your own installed <code>copilot</code>, exactly as running it in a terminal does.
        </li>
        <li>
          <strong>What is sent to GitHub:</strong> your message, and whatever the agent then reads in that repository
          to do the work.
        </li>
        <li>The repository&apos;s instruction files apply, as they do in the terminal.</li>
        <li>
          <strong>Every action asks first.</strong> Before the agent writes a file or runs a command you see exactly
          what it wants to do and choose to allow or deny it. The only exception is one you make yourself: you can switch
          a single session to Allow all, and it is never remembered.
        </li>
        <li>
          The session is saved with your other Copilot CLI sessions under <code>~/.copilot</code>, so you can continue
          it in a terminal with <code>copilot --resume</code>.
        </li>
        <li>Nothing starts in the background, and nothing about it is added to what you share with your team.</li>
      </ul>
      {error !== undefined && <p className="modal-error">{error}</p>}
      <button type="button" className="modal-btn primary" onClick={onAccept}>
        I understand
      </button>
    </div>
  );
}
