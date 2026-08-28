import { useEffect, useState } from 'react';
import type { UpdateStatus } from '../../../shared/updates';

/**
 * The update the main process is currently working on, or `undefined` when
 * there is none.
 *
 * Push-only: main is the only thing that knows, and it starts talking the
 * moment the user consents to the download. There is nothing to poll and
 * nothing to ask for, so the hook has no request side at all.
 */
export function useUpdateStatus(): UpdateStatus | undefined {
  const [status, setStatus] = useState<UpdateStatus | undefined>(undefined);
  useEffect(() => window.desktop?.onUpdateStatus(setStatus), []);
  return status;
}
