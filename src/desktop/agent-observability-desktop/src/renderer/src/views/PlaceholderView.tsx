import type { JSX } from 'react';
import type { ViewId } from '../components/ActivityRail';

/**
 * Stand-in for the views that land in later milestones. Each says plainly what
 * it will do, so the shell is navigable and the scope is visible rather than
 * looking like a broken screen.
 */

const COPY: Record<PlaceholderViewId, { title: string; body: string }> = {
  assistant: {
    title: 'AI Helper',
    body: 'A chat assistant grounded in your local session data, running against the Claude Code CLI on this machine.',
  },
};

/** The destinations that are still stand-ins, narrowed as each one lands. */
type PlaceholderViewId = Exclude<ViewId, 'sessions' | 'overview' | 'hotspots' | 'settings'>;

export function PlaceholderView({ view }: { view: PlaceholderViewId }): JSX.Element {
  const copy = COPY[view];
  return (
    <div className="placeholder">
      <div>
        <h2>{copy.title}</h2>
        <p>{copy.body}</p>
        <p style={{ marginTop: 12, color: 'var(--fg-subtle)' }}>Coming in a later milestone.</p>
      </div>
    </div>
  );
}
