/**
 * (T5) The user's tiling and RNG settings for the Tables screen: read once,
 * again when a sync brought another computer's (`tiling-settings-changed`),
 * and saved on every change - shown at once, read back when the app refused
 * the change (the error says why). Outside the app: nothing.
 */
import { useCallback, useEffect, useState } from "react";

import { errorText, inApp, ipc, onTilingSettingsChanged, type RngSettings, type TilingSettings } from "../../lib/ipc";

export interface TableSettings {
  tiling: TilingSettings | null;
  rng: RngSettings | null;
  /** Reading them failed. */
  failed: string | null;
  /** The last save failed (cleared by the next one). */
  saveError: string | null;
  saveTiling: (next: TilingSettings) => Promise<boolean>;
  saveRng: (next: RngSettings) => Promise<boolean>;
}

export function useTableSettings(): TableSettings {
  const [tiling, setTiling] = useState<TilingSettings | null>(null);
  const [rng, setRng] = useState<RngSettings | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => onTilingSettingsChanged(() => setGeneration((g) => g + 1)), []);
  useEffect(() => {
    if (!inApp) return;
    let live = true;
    Promise.all([ipc.getTilingSettings(), ipc.getRngSettings()])
      .then(([t, r]) => {
        if (!live) return;
        setTiling(t);
        setRng(r);
        setFailed(null);
      })
      .catch((e: unknown) => live && setFailed(errorText(e)));
    return () => {
      live = false;
    };
  }, [generation]);

  const reload = useCallback(() => setGeneration((g) => g + 1), []);

  const saveTiling = useCallback(
    (next: TilingSettings) => {
      setTiling(next);
      setSaveError(null);
      return ipc
        .setTilingSettings(next)
        .then(() => true)
        .catch((e: unknown) => {
          setSaveError(errorText(e));
          reload();
          return false;
        });
    },
    [reload],
  );

  const saveRng = useCallback(
    (next: RngSettings) => {
      setRng(next);
      setSaveError(null);
      return ipc
        .setRngSettings(next)
        .then(() => true)
        .catch((e: unknown) => {
          setSaveError(errorText(e));
          reload();
          return false;
        });
    },
    [reload],
  );

  return { tiling, rng, failed, saveError, saveTiling, saveRng };
}
