/**
 * (#429) The HUD screen's lock, beside its status pill: on, a press on a
 * panel at a table never drags it (a click still opens the popup); off,
 * panels can be dragged as before. Kept in the store (`hud_set_locked`),
 * which the HUD reads at once.
 */
import { useEffect, useState } from "react";

import { useT } from "../../i18n";
import { errorText, inApp, ipc } from "../../lib/ipc";

export function HudLock() {
  const t = useT().hudStatus.lock;
  const [locked, setLocked] = useState<boolean | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    if (!inApp) return;
    let live = true;
    ipc
      .hudLocked()
      .then((value) => {
        if (live) setLocked(value);
      })
      .catch(() => {
        if (live) setLocked(false);
      });
    return () => {
      live = false;
    };
  }, []);

  if (locked === null) return null;

  const toggle = () => {
    const next = !locked;
    setLocked(next);
    setFailed(null);
    ipc.hudSetLocked(next).catch((reason: unknown) => {
      setLocked(!next);
      setFailed(t.failed(errorText(reason)));
    });
  };

  return (
    <button
      type="button"
      className={`chip-btn${locked ? " is-active" : ""}`}
      aria-pressed={locked}
      title={failed ?? (locked ? t.hintOn : t.hintOff)}
      onClick={toggle}
    >
      <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <rect x="3" y="7" width="10" height="8" rx="1.5" fill="currentColor" />
        <path
          d={locked ? "M5 7V5a3 3 0 0 1 6 0v2" : "M5 7V5a3 3 0 0 1 5.8-1"}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
        />
      </svg>{" "}
      {locked ? t.on : t.off}
    </button>
  );
}
