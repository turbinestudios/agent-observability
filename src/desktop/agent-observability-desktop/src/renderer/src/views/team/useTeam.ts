import { useCallback, useEffect, useState } from 'react';
import type { TeamExportResult, TeamPreview, TeamStatus, TeamViewData, TeamWindow } from '../../../../shared/rpc';
import { dataHost } from '../../api/client';

/** The Team view's data, re-read whenever the datahost says the folder or the shard changed. */
export function useTeamView(window: TeamWindow): {
  data: TeamViewData | undefined;
  error: string | undefined;
  reload: () => void;
} {
  const [data, setData] = useState<TeamViewData | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const reload = useCallback(() => {
    dataHost
      .call('team.view', { window })
      .then((next) => {
        setData(next);
        setError(undefined);
      })
      .catch((err: Error) => setError(err.message));
  }, [window]);

  useEffect(() => {
    reload();
    return dataHost.on('team.changed', () => reload());
  }, [reload]);

  return { data, error, reload };
}

/** The user-initiated actions; each resolves to the datahost's answer. */
export function useTeamActions(): {
  exportNow: () => Promise<TeamExportResult>;
  refresh: () => Promise<TeamStatus>;
  preview: () => Promise<TeamPreview>;
} {
  return {
    exportNow: useCallback(() => dataHost.call('team.exportNow'), []),
    refresh: useCallback(() => dataHost.call('team.refresh'), []),
    preview: useCallback(() => dataHost.call('team.preview'), []),
  };
}
