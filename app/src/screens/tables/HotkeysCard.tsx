/**
 * (T7) The Hotkeys card: one row per action - re-tile, next and previous
 * layout, tiling on / off, roll the RNG - with its keys. A click on the
 * keys records new ones (the app lets every bound key go meanwhile, so the
 * keys reach the window: `hotkeys_pause`); Esc cancels; × clears. A key
 * another program holds says so (`hotkey_status`). "Roll the RNG" is
 * greyed while no room allows the RNG. Free: no plan needed.
 */
import { useCallback, useEffect, useState } from "react";

import { useT } from "../../i18n";
import { errorText, ipc, onHotkeysChanged, type HotkeyStatus, type HudPolicy, type TilingSettings } from "../../lib/ipc";
import { HOTKEY_ACTIONS, type KnownHotkeyAction, bindingOf, boundElsewhere, keysFromEvent, keysLabel, keysProblem, setBinding } from "./hotkeys";
import { rngAllowedAnywhere } from "./model";
import styles from "./Tables.module.css";

/** How each binding stands with the system; read again when the app says it changed. */
function useHotkeyStatus(): HotkeyStatus[] {
  const [status, setStatus] = useState<HotkeyStatus[]>([]);
  const [generation, setGeneration] = useState(0);
  useEffect(() => onHotkeysChanged(() => setGeneration((g) => g + 1)), []);
  useEffect(() => {
    let live = true;
    ipc
      .hotkeyStatus()
      .then((s) => live && setStatus(s))
      .catch(() => live && setStatus([]));
    return () => {
      live = false;
    };
  }, [generation]);
  return status;
}

export function HotkeysCard({
  settings,
  policy,
  onSave,
}: {
  settings: TilingSettings;
  policy: HudPolicy;
  onSave: (next: TilingSettings) => Promise<boolean>;
}) {
  const s = useT().tables.hotkeys;
  const status = useHotkeyStatus();
  const [recording, setRecording] = useState<KnownHotkeyAction | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const rngAllowed = rngAllowedAnywhere(policy);

  const stop = useCallback(() => {
    setRecording(null);
    ipc.hotkeysPause(false).catch(() => undefined);
  }, []);

  const start = (action: KnownHotkeyAction) => {
    setProblem(null);
    setRecording(action);
    ipc.hotkeysPause(true).catch((e: unknown) => setProblem(errorText(e)));
  };

  useEffect(() => {
    if (recording === null) return;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.code === "Escape" && !event.ctrlKey && !event.altKey && !event.metaKey) {
        stop();
        return;
      }
      const keys = keysFromEvent(event);
      if (keys === null) return; // a modifier alone: wait for the key
      const refused = keysProblem(keys);
      const other = boundElsewhere(settings, recording, keys);
      if (refused !== null) {
        setProblem(s.problem[refused](keysLabel(keys)));
      } else if (other !== null) {
        setProblem(s.inUse(keysLabel(keys), other === "unknown" ? s.newer : s.action[other]));
      } else {
        setProblem(null);
        void onSave(setBinding(settings, recording, keys));
      }
      stop();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", stop);
    };
  }, [recording, settings, onSave, stop, s]);

  // Leaving the screen while recording binds the keys again.
  useEffect(() => () => void ipc.hotkeysPause(false).catch(() => undefined), []);

  return (
    <section className={styles.card} aria-label={s.label}>
      <span className={styles.cardTitle}>{s.label}</span>
      <ul className={styles.rules}>
        {HOTKEY_ACTIONS.map((action) => {
          const keys = bindingOf(settings, action);
          const state = status.find((st) => st.action === action && st.keys === keys)?.state ?? null;
          const disabled = action === "rollRng" && !rngAllowed;
          const listening = recording === action;
          return (
            <li key={action} className={styles.hotkey} data-disabled={disabled}>
              <span className={styles.hotkeyName} title={disabled ? s.rngNotAllowed : undefined}>
                {s.action[action]}
              </span>
              {state === "taken" || state === "failed" ? (
                <span className={styles.warn} title={state === "taken" ? s.takenHint : undefined}>
                  {state === "taken" ? s.taken : s.failed}
                </span>
              ) : null}
              <button
                type="button"
                className={`chip-btn ${styles.keycap}${listening ? " is-active" : ""}`}
                aria-label={s.record(s.action[action])}
                aria-pressed={listening}
                title={disabled ? s.rngNotAllowed : s.recordHint}
                disabled={disabled}
                onClick={() => (listening ? stop() : start(action))}
              >
                {listening ? s.listening : keys !== null ? keysLabel(keys) : s.none}
              </button>
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                aria-label={s.clear(s.action[action])}
                title={s.clear(s.action[action])}
                disabled={keys === null}
                onClick={() => void onSave(setBinding(settings, action, null))}
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>
      {problem !== null ? <p className={styles.error}>{problem}</p> : null}
    </section>
  );
}
