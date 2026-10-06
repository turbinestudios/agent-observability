import type { JSX } from 'react';
import { useState } from 'react';
import type { RunInputRequest, RunPermissionDecision, RunPermissionRequest } from '../../../../shared/rpc';
import { diffStatLabel, permissionButtons, permissionKindLabel, permissionQueueLabel, permissionSubject } from './run';

/**
 * The agent wants to do something and is waiting. The card shows exactly
 * what, and offers the only three answers there are. There is no "always
 * allow": nothing here outlives the session. When the agent asked for several
 * things at once they are answered one at a time, oldest first.
 */
export function PermissionCard({
  request,
  onDecide,
}: {
  request: RunPermissionRequest;
  onDecide: (decision: RunPermissionDecision, feedback?: string) => void;
}): JSX.Element {
  const [feedback, setFeedback] = useState('');
  const stat = diffStatLabel(request);
  const queue = permissionQueueLabel(request);
  return (
    <div className="run-permission" role="alertdialog" aria-label="The agent is asking for permission">
      <div className="run-permission-head">
        <strong>{permissionKindLabel(request.kind)}</strong>
        {request.intention !== undefined && <span className="card-caption">{request.intention}</span>}
      </div>
      <pre className="run-permission-subject">{permissionSubject(request)}</pre>
      {stat !== undefined && <p className="card-caption">{stat}</p>}
      <input
        className="run-permission-feedback"
        value={feedback}
        placeholder="Optional: tell the agent why you are denying"
        aria-label="Reason for denying"
        onChange={(e) => setFeedback(e.target.value)}
      />
      <div className="modal-actions">
        {permissionButtons(request).map((button) => (
          <button
            key={button.decision}
            type="button"
            className={button.primary ? 'modal-btn primary' : 'modal-btn'}
            onClick={() =>
              onDecide(button.decision, button.decision === 'deny' && feedback.trim().length > 0 ? feedback.trim() : undefined)
            }
          >
            {button.label}
          </button>
        ))}
      </div>
      {queue !== undefined && <p className="card-caption">{queue}</p>}
    </div>
  );
}

/** The agent asked the user a question and is waiting for the answer. */
export function InputCard({
  request,
  onAnswer,
}: {
  request: RunInputRequest;
  onAnswer: (answer: string | undefined) => void;
}): JSX.Element {
  const [text, setText] = useState('');
  return (
    <div className="run-permission" role="alertdialog" aria-label="The agent is asking a question">
      <div className="run-permission-head">
        <strong>The agent is asking</strong>
      </div>
      <p className="run-question">{request.question}</p>
      {request.choices !== undefined && request.choices.length > 0 ? (
        <div className="modal-actions">
          {request.choices.map((choice) => (
            <button key={choice} type="button" className="modal-btn" onClick={() => onAnswer(choice)}>
              {choice}
            </button>
          ))}
          <button type="button" className="modal-btn" onClick={() => onAnswer(undefined)}>
            Skip
          </button>
        </div>
      ) : (
        <div className="modal-actions">
          <input value={text} aria-label="Your answer" onChange={(e) => setText(e.target.value)} />
          <button type="button" className="modal-btn" onClick={() => onAnswer(undefined)}>
            Skip
          </button>
          <button type="button" className="modal-btn primary" disabled={text.trim().length === 0} onClick={() => onAnswer(text.trim())}>
            Answer
          </button>
        </div>
      )}
    </div>
  );
}
