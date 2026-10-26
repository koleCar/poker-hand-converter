import { ProLock } from "../components/ProLock";
import { ScreenHeader } from "../components/ScreenHeader";
import { useT } from "../i18n";
import { useHudCompliance } from "../lib/useHudCompliance";
import { HudEditor } from "./hud/HudEditor";
import { HudStatusPanel } from "./hud/HudStatusPanel";

/**
 * The HUD screen: the HUD at the tables and where it may not be used
 * (R3.10, compliance mode), then the editor of its designs, presets and
 * assignments (R3.9). (R6.4) While the plan holds the HUD back, its lock
 * comes first; the editor stays, so designs can be made ready.
 */
export function Hud() {
  const t = useT();
  const compliance = useHudCompliance();
  return (
    <>
      <ScreenHeader title={t.screens.hud.title} lead={t.screens.hud.lead} />
      <ProLock feature="hud" compact />
      <HudStatusPanel compliance={compliance} />
      <HudEditor />
    </>
  );
}
