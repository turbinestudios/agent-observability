import type { JSX } from 'react';
import type { RunItem } from '../../../../shared/rpc';
import { toolRowSummary } from './run';

/** One tool call in the transcript: its name and whether it is running, done or failed. */
export function ToolRow({ item }: { item: Extract<RunItem, { kind: 'tool' }> }): JSX.Element {
  return (
    <div className={`run-tool run-tool-${item.state}`}>
      <span className="run-tool-state" aria-hidden="true" />
      <span>{toolRowSummary(item)}</span>
    </div>
  );
}
