import { useHudCompliance } from "../../lib/useHudCompliance";
import { HudStatusPanel } from "../hud/HudStatusPanel";

/**
 * Settings, HUD (R3.10, R3.11, R3.6): the HUD at the tables, the
 * Accessibility permission on a Mac, where it may be used and the room
 * list in force, and how each room's client seats the user. The HUD
 * screen keeps the designs.
 */
export function HudSettings() {
  const compliance = useHudCompliance();
  return <HudStatusPanel compliance={compliance} />;
}
