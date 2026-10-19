/**
 * The HUD's status and the room list in force (R3.10), for the HUD screen and
 * Today: `hud_status` and `hud_policy`, asked again when the app says they
 * changed (`hud-status-changed`, `hud-policy-changed`) and every few seconds
 * (the HUD's phase - starting, running, off - changes without an event).
 * `checkNow` asks the web for a new room list at once. Outside the app:
 * nothing.
 */
import { useCallback, useEffect, useState } from "react";

import { errorText, inApp, ipc, onHudPolicyChanged, onHudStatusChanged, type HudPolicy, type HudStatus } from "./ipc";

/** How often the status is asked for while a screen shows it. */
const REFRESH_MS = 3000;

export interface HudCompliance {
  status: HudStatus | null;
  policy: HudPolicy | null;
  error: string | null;
  checking: boolean;
  checkNow: () => void;
}

export function useHudCompliance(): HudCompliance {
  const [status, setStatus] = useState<HudStatus | null>(null);
  const [policy, setPolicy] = useState<HudPolicy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (!inApp) return;
    let live = true;
    const loadStatus = () => {
      ipc
        .hudStatus()
        .then((next) => live && setStatus(next))
        .catch((e: unknown) => live && setError(errorText(e)));
    };
    const loadPolicy = () => {
      ipc
        .hudPolicy()
        .then((next) => live && setPolicy(next))
        .catch((e: unknown) => live && setError(errorText(e)));
    };
    loadStatus();
    loadPolicy();
    const timer = window.setInterval(loadStatus, REFRESH_MS);
    const stopStatus = onHudStatusChanged(loadStatus);
    const stopPolicy = onHudPolicyChanged(() => {
      loadPolicy();
      loadStatus();
    });
    return () => {
      live = false;
      window.clearInterval(timer);
      stopStatus();
      stopPolicy();
    };
  }, []);

  const checkNow = useCallback(() => {
    if (!inApp) return;
    setChecking(true);
    ipc
      .hudPolicyCheck()
      .then((next) => {
        setPolicy(next);
        setError(null);
      })
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setChecking(false));
  }, []);

  return { status, policy, error, checking, checkNow };
}
