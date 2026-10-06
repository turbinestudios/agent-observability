import type { JSX } from 'react';
import type { RunAvailability, RunRepository } from '../../../../shared/rpc';
import { shortRepo } from '../sessions/format';
import { RUN_START_REMINDER, canStart } from './runViewModel';

/**
 * Where a hosted session begins: an editable goal, a repository from the
 * verified list, a model. A door from another view only fills this box; the
 * text here is exactly what Start sends.
 */
interface Props {
  goal: string;
  onGoal: (next: string) => void;
  repository: string;
  onRepository: (next: string) => void;
  model: string;
  onModel: (next: string) => void;
  repositories: RunRepository[];
  availability: RunAvailability;
  busy: boolean;
  onStart: () => void;
  /** Set when the box was filled by a door, so the user knows where the text came from. */
  origin?: string;
}

export function GoalBox(props: Props): JSX.Element {
  const { goal, repository, model, repositories, availability, busy, origin } = props;
  return (
    <section className="card run-goal" aria-label="Start a session">
      <div className="card-head">
        <h2>Start a session</h2>
        {origin !== undefined && <span className="card-note">Filled in from {origin}. Edit it before you start.</span>}
      </div>
      <textarea
        className="run-goal-text"
        value={goal}
        placeholder="What should the agent do?"
        spellCheck
        aria-label="Goal"
        onChange={(e) => props.onGoal(e.target.value)}
      />
      <div className="run-goal-row">
        <label>
          Repository
          <select className="settings-input settings-select" value={repository} onChange={(e) => props.onRepository(e.target.value)}>
            <option value="">Pick a repository</option>
            {repositories.map((repo) => (
              <option key={repo.repository} value={repo.repository} title={repo.cwd}>
                {shortRepo(repo.repository)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Model
          <select className="settings-input settings-select" value={model} onChange={(e) => props.onModel(e.target.value)}>
            <option value="">Default</option>
            {availability.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="modal-btn primary"
          disabled={!canStart(goal, repository, busy)}
          onClick={props.onStart}
        >
          {busy ? 'Starting…' : 'Start'}
        </button>
      </div>
      {repositories.length === 0 && (
        <p className="card-caption">
          No checkout could be verified yet. Run an agent session in a repository once and it will appear here.
        </p>
      )}
      <p className="card-caption">{RUN_START_REMINDER}</p>
    </section>
  );
}
