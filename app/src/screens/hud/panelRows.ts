/**
 * A design's panel as the HUD lays it out: rows of `columns` slots, top to
 * bottom. Today the cells fill the rows in order and only the last row can
 * be short; a slot with nothing in it is `null` (the panel's grid keeps its
 * width). The one place the small panels of At the tables read the layout
 * from, so a change of the design model changes only this.
 */
import type { DesignCell, HudDesign } from "../../lib/ipc";

export function panelRows(design: HudDesign): (DesignCell | null)[][] {
  const columns = Math.max(1, design.columns);
  const rows: (DesignCell | null)[][] = [];
  for (let start = 0; start < design.cells.length; start += columns) {
    const row: (DesignCell | null)[] = design.cells.slice(start, start + columns);
    while (row.length < columns) row.push(null);
    rows.push(row);
  }
  return rows;
}
