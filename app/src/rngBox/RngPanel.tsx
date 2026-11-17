/**
 * The RNG panel (`src-tauri/src/rng_box.rs`, `rng_panel_toggle`; the
 * owner's brief of 2026-11-17): a right-click on the RNG box opens it
 * beside the box - the lock, "Reposition" and the box's look, the rows of
 * Settings > RNG (`Rng` with `panel`), so nothing needs the main window.
 * Esc, its close button or another right-click on the box closes it.
 */
import { useEffect } from "react";

import { useT } from "../i18n";
import { ipc } from "../lib/ipc";
import { Rng } from "../screens/settings/Rng";
import styles from "./RngPanel.module.css";

export function RngPanelWindow() {
  const t = useT().settings.rng;
  const close = () => {
    ipc.rngPanelClose().catch(() => undefined);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className={styles.panel}>
      <header className={styles.header}>
        <span className={styles.title}>{t.panelTitle}</span>
        <button type="button" className={styles.close} aria-label={t.close} title={t.close} onClick={close}>
          ×
        </button>
      </header>
      <div className={styles.body}>
        <Rng panel />
      </div>
    </div>
  );
}
