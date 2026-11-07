import { useEffect } from "react";

import { ProLock } from "../components/ProLock";
import { ScreenHeader } from "../components/ScreenHeader";
import { useT } from "../i18n";
import { HUD_TABLES, useRouteParam } from "../lib/router";
import { useHudCompliance } from "../lib/useHudCompliance";
import { HudEditor } from "./hud/HudEditor";
import { HudNotice } from "./hud/HudNotice";
import { HudStatusPanel } from "./hud/HudStatusPanel";
import styles from "./hud/HudEditor.module.css";

/**
 * The HUD screen: the editor of its designs, presets and assignments
 * (R3.9), the panel first; under it the HUD at the tables and where it may
 * be used (R3.10, compliance mode; `#/hud/tables` opens there), with a line
 * on top when the user has something to do there. (R6.4) While the plan
 * holds the HUD back, its lock comes first; the editor stays, so designs
 * can be made ready.
 */
export function Hud() {
  const t = useT();
  const compliance = useHudCompliance();
  const param = useRouteParam();

  useEffect(() => {
    if (param !== HUD_TABLES) return;
    const frame = window.requestAnimationFrame(() => {
      const node = document.getElementById("hud-tables");
      node?.scrollIntoView({ block: "start" });
      node?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [param]);

  return (
    <>
      <ScreenHeader title={t.screens.hud.title} />
      <ProLock feature="hud" compact />
      <HudNotice compliance={compliance} />
      <HudEditor />
      <div id="hud-tables" className={styles.tables} tabIndex={-1}>
        <HudStatusPanel compliance={compliance} />
      </div>
    </>
  );
}
