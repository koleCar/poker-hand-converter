/**
 * Whether the HUD has a poker table open (R3.8, guideline A10): while it
 * has, the app hides what could help during play - the replayer's pot odds
 * and the starting-hand chart today, the analysis and solver screens when
 * they come (R5.4). The HUD's own count (`hud_status`), then every edge
 * the app reports (`hud-tables-open`). Outside the app: never.
 */
import { useEffect, useState } from "react";

import { inApp, ipc, onTablesOpen } from "./ipc";

export function useTablesOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!inApp) return;
    let live = true;
    let heard = false;
    const stop = onTablesOpen((value) => {
      heard = true;
      setOpen(value);
    });
    ipc
      .hudStatus()
      .then((status) => {
        // An edge heard meanwhile is newer than this answer.
        if (live && !heard) setOpen(status.tablesOpen > 0);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      stop();
    };
  }, []);
  return open;
}
