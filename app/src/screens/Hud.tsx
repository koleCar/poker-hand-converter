import { ScreenHeader } from "../components/ScreenHeader";
import { useT } from "../i18n";
import { HudEditor } from "./hud/HudEditor";

/** The HUD screen (R3.9): the editor of the HUD's designs, presets and assignments. */
export function Hud() {
  const t = useT();
  return (
    <>
      <ScreenHeader title={t.screens.hud.title} lead={t.screens.hud.lead} />
      <HudEditor />
    </>
  );
}
