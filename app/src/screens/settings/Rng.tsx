/**
 * Settings, RNG (the owner's brief of 2026-11-16, moved here from the
 * Tables screen): one switch for the RNG box - a number from 1 to 100 in
 * the primary monitor's top-right corner while a session is live
 * (`src-tauri/src/rng_box.rs`). The switch is `RngSettings.enabled`, stored
 * and synced as before; the box shows or goes as soon as it is saved.
 */
import { useEffect, useId, useState } from "react";

import { useT } from "../../i18n";
import { errorText, ipc, onTilingSettingsChanged, type RngSettings } from "../../lib/ipc";
import styles from "./Settings.module.css";
import { Toggle } from "./Toggle";

export function Rng() {
  const t = useT().settings;
  const id = useId();
  const [rng, setRng] = useState<RngSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  // Read again when a sync brought another computer's settings.
  useEffect(() => onTilingSettingsChanged(() => setGeneration((g) => g + 1)), []);
  useEffect(() => {
    let live = true;
    ipc
      .getRngSettings()
      .then((settings) => live && setRng(settings))
      .catch((e: unknown) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [generation]);

  const toggle = (on: boolean) => {
    if (rng === null) return;
    const next = { ...rng, enabled: on };
    setRng(next);
    setError(null);
    ipc.setRngSettings(next).catch((e: unknown) => {
      setError(errorText(e));
      setGeneration((g) => g + 1);
    });
  };

  return (
    <>
      <div className={styles.card}>
        <div className={`${styles.row} ${styles.rowWide}`} title={t.rng.hint}>
          <label htmlFor={id}>{t.rng.show}</label>
          <Toggle id={id} checked={rng?.enabled ?? false} disabled={rng === null} onChange={toggle} />
        </div>
      </div>
      {error && (
        <p className={`${styles.note} ${styles.error}`} role="alert">
          {t.saveFailed(error)}
        </p>
      )}
    </>
  );
}
