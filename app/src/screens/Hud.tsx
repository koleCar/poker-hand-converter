import { ProLock } from "../components/ProLock";
import { ScreenHeader } from "../components/ScreenHeader";
import { useT } from "../i18n";
import { useHudCompliance } from "../lib/useHudCompliance";
import { HudEditor } from "./hud/HudEditor";
import { HudNotice } from "./hud/HudNotice";

/**
 * The HUD screen: the editor of its designs, presets and assignments
 * (R3.9), the panel first. The HUD at the tables and where it may be used
 * (R3.10, compliance mode) are in Settings, HUD; here only a line when the
 * user has something to do there. (R6.4) While the plan holds the HUD
 * back, its lock comes first; the editor stays, so designs can be made
 * ready.
 */
export function Hud() {
  const t = useT();
  const compliance = useHudCompliance();
  return (
    <>
      <ScreenHeader title={t.screens.hud.title} />
      <ProLock feature="hud" compact />
      <HudNotice compliance={compliance} />
      <HudEditor />
    </>
  );
}
