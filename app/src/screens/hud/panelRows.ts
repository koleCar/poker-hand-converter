/**
 * A design's panel as the HUD lays it out: the grid's rows, top to bottom,
 * a statistic or an empty slot (`null`) each, without the empty rows and
 * columns at its end (the HUD cuts them off too, `HudDesign::trimmed`). The
 * one place the small panels of At the tables read the layout from.
 */
import type { DesignCell, HudDesign } from "../../lib/ipc";
import { minSize, slots } from "./grid";

export function panelRows(design: HudDesign): (DesignCell | null)[][] {
  const all = slots(design);
  const { rows, columns } = minSize(design);
  return Array.from({ length: rows }, (_, row) =>
    Array.from({ length: columns }, (_, col) => all[row * design.columns + col] ?? null),
  );
}
