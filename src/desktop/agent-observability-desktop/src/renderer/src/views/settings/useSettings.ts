import { useCallback, useEffect, useState } from 'react';
import { dataHost } from '../../api/client';
import type { SettingsPatch, SettingsSnapshot } from '../../../../shared/rpc';

/**
 * The settings page's data: the current snapshot, and a `save` that persists a
 * patch and swaps in the snapshot the data host returns — so the page always
 * shows the effective state (trimmed paths, re-resolved auto-detection), not
 * what was typed.
 */
export function useSettings(): {
  snapshot: SettingsSnapshot | undefined;
  error: string | undefined;
  saving: boolean;
  save: (patch: SettingsPatch) => void;
} {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    dataHost
      .call('settings.get')
      .then((next) => {
        if (!cancelled) {
          setSnapshot(next);
          setError(undefined);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback((patch: SettingsPatch) => {
    setSaving(true);
    dataHost
      .call('settings.update', patch)
      .then((next) => {
        setSnapshot(next);
        setError(undefined);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setSaving(false));
  }, []);

  return { snapshot, error, saving, save };
}
