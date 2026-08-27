import type { JSX } from 'react';
import type { ViewId } from '../components/ActivityRail';

/**
 * Stand-in for the views that land in later milestones. Each says plainly what
 * it will do, so the shell is navigable and the scope is visible rather than
 * looking like a broken screen.
 */

const COPY: Record<Exclude<ViewId, 'sessions' | 'overview' | 'settings'>, { title: string; body: string }> = {
  hotspots: {
    title: 'Context Hotspots',
    body: 'Which instruction and customization files your agents actually load, ranked by how often they are pulled into context.',
  },
  assistant: {
    title: 'AI Helper',
    body: 'A chat assistant grounded in your local session data, running against the Claude Code CLI on this machine.',
  },
  sync: {
    title: 'Sync',
    body: 'Consent, API key, and upload status for opt-in aggregate sharing. Raw session content never leaves this machine.',
  },
};

export function PlaceholderView({
  view,
}: {
  view: Exclude<ViewId, 'sessions' | 'overview' | 'settings'>;
}): JSX.Element {
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
