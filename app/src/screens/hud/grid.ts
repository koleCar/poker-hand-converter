/**
 * The panel's grid (R3.9, `rail_hud::design::HudDesign`): `rows` x
 * `columns` slots, row by row, a statistic or empty (`null`) each. The HUD
 * draws the grid as it is - an empty slot is blank space - without the
 * empty rows and columns at its end, which the editor keeps only while the
 * user arranges the panel (the Rust side cuts them off on save,
 * `HudDesign::trimmed`). These are the editor's moves on it; whether the
 * result may be saved is the Rust side's (`hud_design_check`).
 */
import type { DesignCell, HudDesign } from "../../lib/ipc";

/** A slot's place. */
export interface Place {
  row: number;
  col: number;
}

/** The grid's slots, exactly `rows` x `columns` of them. */
export function slots(design: HudDesign): (DesignCell | null)[] {
  const count = design.rows * design.columns;
  return Array.from({ length: count }, (_, i) => design.cells[i] ?? null);
}

export const placeOf = (design: HudDesign, slot: number): Place => ({
  row: Math.floor(slot / design.columns),
  col: slot % design.columns,
});

/** The statistics on the panel. */
export const statCount = (design: HudDesign): number => design.cells.filter((cell) => cell !== null).length;

/** The slot of statistic `id`, or -1. */
export const slotOfStat = (design: HudDesign, id: string): number => design.cells.findIndex((cell) => cell?.stat === id);

/**
 * The smallest grid that keeps every statistic where it is: the last used
 * row and column (at least one of each). The grid shrinks no further.
 */
export function minSize(design: HudDesign): { rows: number; columns: number } {
  let rows = 1;
  let columns = 1;
  design.cells.forEach((cell, slot) => {
    if (cell === null) return;
    const { row, col } = placeOf(design, slot);
    rows = Math.max(rows, row + 1);
    columns = Math.max(columns, col + 1);
  });
  return { rows, columns };
}

/** The grid at `rows` x `columns`, every statistic at its row and column (callers keep it at least `minSize`). */
export function resize(design: HudDesign, rows: number, columns: number): HudDesign {
  const cells: (DesignCell | null)[] = Array.from({ length: rows * columns }, () => null);
  design.cells.forEach((cell, slot) => {
    if (cell === null) return;
    const { row, col } = placeOf(design, slot);
    if (row < rows && col < columns) cells[row * columns + col] = cell;
  });
  return { ...design, rows, columns, cells };
}

/** `cells` with slot `slot` set (the grid is made up to its size first). */
export function withSlot(design: HudDesign, slot: number, cell: DesignCell | null): HudDesign {
  const cells = slots(design);
  cells[slot] = cell;
  return { ...design, cells };
}

/**
 * The first empty slot, row by row; with none, the grid grows by a row
 * (else by a column) within `limits`. `null`: no room at all.
 */
export function roomFor(
  design: HudDesign,
  limits: { maxRows: number; maxColumns: number },
): { design: HudDesign; slot: number } | null {
  const empty = slots(design).indexOf(null);
  if (empty >= 0) return { design: { ...design, cells: slots(design) }, slot: empty };
  if (design.rows < limits.maxRows) {
    const grown = resize(design, design.rows + 1, design.columns);
    return { design: grown, slot: design.rows * design.columns };
  }
  if (design.columns < limits.maxColumns) {
    const grown = resize(design, design.rows, design.columns + 1);
    return { design: grown, slot: design.columns };
  }
  return null;
}
