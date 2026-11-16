/**
 * The RNG box (`src-tauri/src/rng_box.rs`, the owner's brief of
 * 2026-11-16): the app's own small window in the primary monitor's
 * top-right corner while a session is live, showing one number from 1 to
 * 100. A click shows a new one; the "Roll the RNG" hotkey does too (the
 * Rust side rolls and tells the window). Nothing else: no label, no range,
 * no colours.
 */
import { useCallback, useEffect, useState } from "react";

import { useT } from "../i18n";
import { inApp, ipc, onRngBoxRolled } from "../lib/ipc";
import styles from "./RngBox.module.css";

export function RngBoxWindow() {
  const t = useT().rngBox;
  const [number, setNumber] = useState<number | null>(null);

  useEffect(() => {
    if (!inApp) return;
    let live = true;
    ipc
      .rngBoxNumber()
      .then((n) => live && setNumber(n))
      .catch(() => undefined);
    const stop = onRngBoxRolled(setNumber);
    return () => {
      live = false;
      stop();
    };
  }, []);

  const roll = useCallback(() => {
    ipc
      .rngBoxRoll()
      .then(setNumber)
      .catch(() => undefined);
  }, []);

  return (
    <button type="button" className={styles.box} title={t.hint} aria-label={t.label(number)} onClick={roll}>
      <span aria-live="polite">{number ?? "…"}</span>
    </button>
  );
}
