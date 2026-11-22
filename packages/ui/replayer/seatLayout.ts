/**
 * Where a seat goes.
 *
 * This replaces the old angle-plus-CSS-radius ring, which could not work:
 * nothing in it knew how big a seat was, so collision avoidance was a set of
 * per-breakpoint radii tuned by eye, and the "ellipse" had already been warped
 * into something that was not an ellipse to keep portrait seats off the board.
 * Six hole cards make a plate two to three times wider, and no two-knob formula
 * absorbs that.
 *
 * So the geometry is data. Four shapes x nine seat counts is thirty-six arrays
 * a designer fixes once, which is what the big rooms actually ship. Every
 * number below is a fraction of the felt box, and the arrays were produced by
 * walking a designed ring per shape and then *checked*: no seat block overlaps
 * another, the middle, or the edge of the box, at any count, for any shape.
 * `SEAT_SIZE` and `SHAPE_METRICS` are what made that check possible and are the
 * same numbers the stylesheet sizes seats and the board with, so the two cannot
 * drift.
 *
 * Index 0 is the focused seat — the hero, at the bottom — and the rest run
 * clockwise from it, which on screen means up the left flank first.
 *
 * Sizes here are in `u`: one percent of the felt box's shorter side, which is
 * the stylesheet's `--u: 1cqmin`. Positions are plain 0..1 fractions of the
 * box, because that is what `left` / `top` percentages want.
 */

/**
 * The felt's proportions. Chosen in JS rather than by a media query so this
 * table and the stylesheet can never disagree about which one is in force.
 */
export type TableShape = "wide" | "classic" | "tall" | "compact";

export interface SeatSlot {
  /** Anchor point, as a fraction of the felt box. */
  x: number;
  y: number;
  /** Which point of the seat block lands on the anchor (0..1 of the block). */
  ax: number;
  ay: number;
  /** Designed chip spot. Not derived from the seat: designed against it. */
  cx: number;
  cy: number;
  /** -1 the stack hangs left of `cx`, 0 centred on it, 1 hangs right. */
  chipAnchor: -1 | 0 | 1;
  /**
   * Where the bet goes instead on a felt too short to fit it in front of the
   * seat (the stylesheet decides when). Only the hero's slot on a wide felt
   * has one: there the board and the hero's board-sized cards leave too little
   * cloth between them below about 24rem of height.
   */
  sx?: number;
  sy?: number;
}

/**
 * How crowded the table is. Seats shrink as the ring fills up — the one thing
 * about a seat that genuinely depends on the seat count, and the reason the
 * slot tables could be checked for overlap at all.
 */
export type SeatCrowd = "s" | "m" | "b" | "f";

const CROWD: Record<number, SeatCrowd> = {
  2: "s", 3: "s", 4: "s", 5: "m", 6: "m", 7: "b", 8: "b", 9: "f", 10: "f",
};

/** `[width, height]` of a seat block, in u. */
export const SEAT_SIZE: Record<TableShape, Record<SeatCrowd, readonly [number, number]>> = {
  wide: { s: [26, 21], m: [24, 20], b: [22, 19], f: [21, 18] },
  classic: { s: [24, 21], m: [23, 20], b: [22, 19], f: [21, 18] },
  tall: { s: [24, 22], m: [23, 21], b: [22, 20], f: [21, 19] },
  compact: { s: [26, 17], m: [25, 16], b: [24, 15], f: [23, 14] },
};

export interface ShapeMetrics {
  /**
   * Aspect ratio of the felt box. The felt is letterboxed inside the stage at
   * this ratio, and is allowed to stretch along the axis that only spreads
   * things apart: a wide felt may get wider (up to `arMax`), a tall one taller
   * (down to `arMin`). Sizes are in `u`, one percent of the *shorter* side, so
   * stretching the longer side moves seats away from each other and never
   * towards — the overlap check made at `arW / arH` still holds.
   */
  arW: number;
  arH: number;
  arMin: number;
  arMax: number;
  /**
   * Board card width: `min(cap * u, slope * u + base)`, base in rem. The board
   * is always one row of five, so the cap is what keeps five cards and their
   * gaps inside the table; the slope and base make a small felt's cards a
   * little bigger than a straight share of it (a phone on its side) without
   * blowing up on a 4K screen.
   */
  boardCard: number;
  boardSlope: number;
  boardBase: number;
  /** Height of the pot pill above the board, in u. */
  potH: number;
}

// The board is one row of five at every shape (design 7, round 2): a felt that
// folded it into 3 + 2 read as two boards. The hero's hole cards are drawn at
// the board's size, so these numbers are also how big the hand you are here to
// read is.
export const SHAPE_METRICS: Record<TableShape, ShapeMetrics> = {
  wide: { arW: 16, arH: 9, arMin: 16 / 9, arMax: 2, boardCard: 15, boardSlope: 8.76, boardBase: 1.375, potH: 7 },
  classic: { arW: 4, arH: 3, arMin: 4 / 3, arMax: 1.54, boardCard: 13, boardSlope: 8.76, boardBase: 1.375, potH: 7 },
  tall: { arW: 2, arH: 3, arMin: 0.5, arMax: 2 / 3, boardCard: 16.7, boardSlope: 16.7, boardBase: 0, potH: 7 },
  compact: { arW: 1, arH: 1, arMin: 1, arMax: 1, boardCard: 8.5, boardSlope: 8.5, boardBase: 0, potH: 7 },
};

/**
 * The slot tables. Fractions of the felt box; see the file header.
 */
export const SEAT_SLOTS: Record<TableShape, Record<number, SeatSlot[]>> = {
  /* 16:9 — desktop, and a phone on its side. Three seats along the bottom and up to four across the top at a full ring. */
  wide: {
    2: [
      { x: 0.5, y: 0.956, ax: 0.5, ay: 1, cx: 0.5, cy: 0.609, chipAnchor: 0, sx: 0.66, sy: 0.78 },
      { x: 0.5, y: 0.03, ax: 0.5, ay: 0, cx: 0.62, cy: 0.27, chipAnchor: 0 },
    ],
    3: [
      { x: 0.5, y: 0.956, ax: 0.5, ay: 1, cx: 0.5, cy: 0.609, chipAnchor: 0, sx: 0.66, sy: 0.78 },
      { x: 0.328, y: 0.09, ax: 0.5, ay: 0, cx: 0.328, cy: 0.345, chipAnchor: 0 },
      { x: 0.673, y: 0.09, ax: 0.5, ay: 0, cx: 0.673, cy: 0.345, chipAnchor: 0 },
    ],
    4: [
      { x: 0.5, y: 0.956, ax: 0.5, ay: 1, cx: 0.5, cy: 0.609, chipAnchor: 0, sx: 0.66, sy: 0.78 },
      { x: 0.05, y: 0.5, ax: 0, ay: 0.5, cx: 0.222, cy: 0.64, chipAnchor: 1 },
      { x: 0.5, y: 0.03, ax: 0.5, ay: 0, cx: 0.62, cy: 0.27, chipAnchor: 0 },
      { x: 0.95, y: 0.5, ax: 1, ay: 0.5, cx: 0.778, cy: 0.64, chipAnchor: -1 },
    ],
    5: [
      { x: 0.5, y: 0.956, ax: 0.5, ay: 1, cx: 0.5, cy: 0.609, chipAnchor: 0, sx: 0.66, sy: 0.78 },
      { x: 0.05, y: 0.5, ax: 0, ay: 0.5, cx: 0.217, cy: 0.64, chipAnchor: 1 },
      { x: 0.328, y: 0.09, ax: 0.5, ay: 0, cx: 0.328, cy: 0.34, chipAnchor: 0 },
      { x: 0.673, y: 0.09, ax: 0.5, ay: 0, cx: 0.673, cy: 0.34, chipAnchor: 0 },
      { x: 0.95, y: 0.5, ax: 1, ay: 0.5, cx: 0.783, cy: 0.64, chipAnchor: -1 },
    ],
    6: [
      { x: 0.5, y: 0.956, ax: 0.5, ay: 1, cx: 0.5, cy: 0.609, chipAnchor: 0, sx: 0.66, sy: 0.78 },
      { x: 0.093, y: 0.771, ax: 0.5, ay: 1, cx: 0.2, cy: 0.64, chipAnchor: 1 },
      { x: 0.01, y: 0.411, ax: 0, ay: 1, cx: 0.2, cy: 0.3, chipAnchor: 1 },
      { x: 0.5, y: 0.03, ax: 0.5, ay: 0, cx: 0.62, cy: 0.27, chipAnchor: 0 },
      { x: 0.99, y: 0.411, ax: 1, ay: 1, cx: 0.8, cy: 0.3, chipAnchor: -1 },
      { x: 0.907, y: 0.771, ax: 0.5, ay: 1, cx: 0.8, cy: 0.64, chipAnchor: -1 },
    ],
    7: [
      { x: 0.5, y: 0.956, ax: 0.5, ay: 1, cx: 0.5, cy: 0.609, chipAnchor: 0, sx: 0.63, sy: 0.745 },
      { x: 0.155, y: 0.91, ax: 0.5, ay: 1, cx: 0.26, cy: 0.735, chipAnchor: 0 },
      { x: 0.05, y: 0.5, ax: 0, ay: 0.5, cx: 0.211, cy: 0.64, chipAnchor: 1 },
      { x: 0.328, y: 0.09, ax: 0.5, ay: 0, cx: 0.328, cy: 0.335, chipAnchor: 0 },
      { x: 0.673, y: 0.09, ax: 0.5, ay: 0, cx: 0.673, cy: 0.335, chipAnchor: 0 },
      { x: 0.95, y: 0.5, ax: 1, ay: 0.5, cx: 0.789, cy: 0.64, chipAnchor: -1 },
      { x: 0.845, y: 0.91, ax: 0.5, ay: 1, cx: 0.74, cy: 0.735, chipAnchor: 0 },
    ],
    8: [
      { x: 0.5, y: 0.956, ax: 0.5, ay: 1, cx: 0.5, cy: 0.609, chipAnchor: 0, sx: 0.63, sy: 0.745 },
      { x: 0.155, y: 0.91, ax: 0.5, ay: 1, cx: 0.26, cy: 0.735, chipAnchor: 0 },
      { x: 0.05, y: 0.5, ax: 0, ay: 0.5, cx: 0.211, cy: 0.64, chipAnchor: 1 },
      { x: 0.27, y: 0.06, ax: 0.5, ay: 0, cx: 0.27, cy: 0.29, chipAnchor: 0 },
      { x: 0.5, y: 0.06, ax: 0.5, ay: 0, cx: 0.5, cy: 0.29, chipAnchor: 0 },
      { x: 0.73, y: 0.06, ax: 0.5, ay: 0, cx: 0.73, cy: 0.29, chipAnchor: 0 },
      { x: 0.95, y: 0.5, ax: 1, ay: 0.5, cx: 0.789, cy: 0.64, chipAnchor: -1 },
      { x: 0.845, y: 0.91, ax: 0.5, ay: 1, cx: 0.74, cy: 0.735, chipAnchor: 0 },
    ],
    9: [
      { x: 0.5, y: 0.956, ax: 0.5, ay: 1, cx: 0.5, cy: 0.609, chipAnchor: 0, sx: 0.63, sy: 0.745 },
      { x: 0.155, y: 0.91, ax: 0.5, ay: 1, cx: 0.26, cy: 0.735, chipAnchor: 0 },
      { x: 0.05, y: 0.605, ax: 0, ay: 0.5, cx: 0.18, cy: 0.605, chipAnchor: 1 },
      { x: 0.05, y: 0.395, ax: 0, ay: 0.5, cx: 0.18, cy: 0.395, chipAnchor: 1 },
      { x: 0.328, y: 0.09, ax: 0.5, ay: 0, cx: 0.328, cy: 0.33, chipAnchor: 0 },
      { x: 0.673, y: 0.09, ax: 0.5, ay: 0, cx: 0.673, cy: 0.33, chipAnchor: 0 },
      { x: 0.95, y: 0.395, ax: 1, ay: 0.5, cx: 0.82, cy: 0.395, chipAnchor: -1 },
      { x: 0.95, y: 0.605, ax: 1, ay: 0.5, cx: 0.82, cy: 0.605, chipAnchor: -1 },
      { x: 0.845, y: 0.91, ax: 0.5, ay: 1, cx: 0.74, cy: 0.735, chipAnchor: 0 },
    ],
    10: [
      { x: 0.5, y: 0.956, ax: 0.5, ay: 1, cx: 0.5, cy: 0.609, chipAnchor: 0, sx: 0.63, sy: 0.745 },
      { x: 0.155, y: 0.91, ax: 0.5, ay: 1, cx: 0.26, cy: 0.735, chipAnchor: 0 },
      { x: 0.05, y: 0.605, ax: 0, ay: 0.5, cx: 0.18, cy: 0.605, chipAnchor: 1 },
      { x: 0.05, y: 0.395, ax: 0, ay: 0.5, cx: 0.18, cy: 0.395, chipAnchor: 1 },
      { x: 0.27, y: 0.06, ax: 0.5, ay: 0, cx: 0.27, cy: 0.29, chipAnchor: 0 },
      { x: 0.5, y: 0.06, ax: 0.5, ay: 0, cx: 0.5, cy: 0.29, chipAnchor: 0 },
      { x: 0.73, y: 0.06, ax: 0.5, ay: 0, cx: 0.73, cy: 0.29, chipAnchor: 0 },
      { x: 0.95, y: 0.395, ax: 1, ay: 0.5, cx: 0.82, cy: 0.395, chipAnchor: -1 },
      { x: 0.95, y: 0.605, ax: 1, ay: 0.5, cx: 0.82, cy: 0.605, chipAnchor: -1 },
      { x: 0.845, y: 0.91, ax: 0.5, ay: 1, cx: 0.74, cy: 0.735, chipAnchor: 0 },
    ],
  },
  /* 4:3 — a tablet, a narrow column, a feed card. The same rings as `wide`, pulled in. */
  classic: {
    2: [
      { x: 0.5, y: 0.956, ax: 0.5, ay: 1, cx: 0.5, cy: 0.655, chipAnchor: 0 },
      { x: 0.5, y: 0.03, ax: 0.5, ay: 0, cx: 0.5, cy: 0.245, chipAnchor: 0 },
    ],
    3: [
      { x: 0.5, y: 0.956, ax: 0.5, ay: 1, cx: 0.5, cy: 0.655, chipAnchor: 0 },
      { x: 0.333, y: 0.075, ax: 0.5, ay: 0, cx: 0.333, cy: 0.341, chipAnchor: 0 },
      { x: 0.668, y: 0.075, ax: 0.5, ay: 0, cx: 0.668, cy: 0.341, chipAnchor: 0 },
    ],
    4: [
      { x: 0.5, y: 0.956, ax: 0.5, ay: 1, cx: 0.5, cy: 0.655, chipAnchor: 0 },
      { x: 0.03, y: 0.5, ax: 0, ay: 0.5, cx: 0.214, cy: 0.64, chipAnchor: 1 },
      { x: 0.5, y: 0.03, ax: 0.5, ay: 0, cx: 0.5, cy: 0.245, chipAnchor: 0 },
      { x: 0.97, y: 0.5, ax: 1, ay: 0.5, cx: 0.786, cy: 0.64, chipAnchor: -1 },
    ],
    5: [
      { x: 0.5, y: 0.956, ax: 0.5, ay: 1, cx: 0.5, cy: 0.655, chipAnchor: 0 },
      { x: 0.03, y: 0.5, ax: 0, ay: 0.5, cx: 0.214, cy: 0.64, chipAnchor: 1 },
      { x: 0.333, y: 0.075, ax: 0.5, ay: 0, cx: 0.333, cy: 0.336, chipAnchor: 0 },
      { x: 0.668, y: 0.075, ax: 0.5, ay: 0, cx: 0.668, cy: 0.336, chipAnchor: 0 },
      { x: 0.97, y: 0.5, ax: 1, ay: 0.5, cx: 0.786, cy: 0.64, chipAnchor: -1 },
    ],
    6: [
      { x: 0.5, y: 0.956, ax: 0.5, ay: 1, cx: 0.5, cy: 0.655, chipAnchor: 0 },
      { x: 0.107, y: 0.771, ax: 0.5, ay: 1, cx: 0.19, cy: 0.64, chipAnchor: 1 },
      { x: 0.01, y: 0.411, ax: 0, ay: 1, cx: 0.19, cy: 0.3, chipAnchor: 1 },
      { x: 0.5, y: 0.03, ax: 0.5, ay: 0, cx: 0.5, cy: 0.245, chipAnchor: 0 },
      { x: 0.99, y: 0.411, ax: 1, ay: 1, cx: 0.81, cy: 0.3, chipAnchor: -1 },
      { x: 0.893, y: 0.771, ax: 0.5, ay: 1, cx: 0.81, cy: 0.64, chipAnchor: -1 },
    ],
    7: [
      { x: 0.5, y: 0.956, ax: 0.5, ay: 1, cx: 0.5, cy: 0.655, chipAnchor: 0 },
      { x: 0.165, y: 0.925, ax: 0.5, ay: 1, cx: 0.26, cy: 0.735, chipAnchor: 0 },
      { x: 0.03, y: 0.5, ax: 0, ay: 0.5, cx: 0.214, cy: 0.64, chipAnchor: 1 },
      { x: 0.333, y: 0.075, ax: 0.5, ay: 0, cx: 0.333, cy: 0.331, chipAnchor: 0 },
      { x: 0.668, y: 0.075, ax: 0.5, ay: 0, cx: 0.668, cy: 0.331, chipAnchor: 0 },
      { x: 0.97, y: 0.5, ax: 1, ay: 0.5, cx: 0.786, cy: 0.64, chipAnchor: -1 },
      { x: 0.835, y: 0.925, ax: 0.5, ay: 1, cx: 0.74, cy: 0.735, chipAnchor: 0 },
    ],
    8: [
      { x: 0.5, y: 0.956, ax: 0.5, ay: 1, cx: 0.5, cy: 0.655, chipAnchor: 0 },
      { x: 0.165, y: 0.925, ax: 0.5, ay: 1, cx: 0.26, cy: 0.735, chipAnchor: 0 },
      { x: 0.03, y: 0.5, ax: 0, ay: 0.5, cx: 0.214, cy: 0.64, chipAnchor: 1 },
      { x: 0.277, y: 0.075, ax: 0.5, ay: 0, cx: 0.277, cy: 0.29, chipAnchor: 0 },
      { x: 0.5, y: 0.075, ax: 0.5, ay: 0, cx: 0.5, cy: 0.29, chipAnchor: 0 },
      { x: 0.723, y: 0.075, ax: 0.5, ay: 0, cx: 0.723, cy: 0.29, chipAnchor: 0 },
      { x: 0.97, y: 0.5, ax: 1, ay: 0.5, cx: 0.786, cy: 0.64, chipAnchor: -1 },
      { x: 0.835, y: 0.925, ax: 0.5, ay: 1, cx: 0.74, cy: 0.735, chipAnchor: 0 },
    ],
    9: [
      { x: 0.5, y: 0.956, ax: 0.5, ay: 1, cx: 0.5, cy: 0.655, chipAnchor: 0 },
      { x: 0.165, y: 0.925, ax: 0.5, ay: 1, cx: 0.26, cy: 0.735, chipAnchor: 0 },
      { x: 0.05, y: 0.615, ax: 0, ay: 0.5, cx: 0.215, cy: 0.615, chipAnchor: 1 },
      { x: 0.05, y: 0.385, ax: 0, ay: 0.5, cx: 0.215, cy: 0.385, chipAnchor: 1 },
      { x: 0.333, y: 0.075, ax: 0.5, ay: 0, cx: 0.333, cy: 0.32, chipAnchor: 0 },
      { x: 0.668, y: 0.075, ax: 0.5, ay: 0, cx: 0.668, cy: 0.32, chipAnchor: 0 },
      { x: 0.95, y: 0.385, ax: 1, ay: 0.5, cx: 0.785, cy: 0.385, chipAnchor: -1 },
      { x: 0.95, y: 0.615, ax: 1, ay: 0.5, cx: 0.785, cy: 0.615, chipAnchor: -1 },
      { x: 0.835, y: 0.925, ax: 0.5, ay: 1, cx: 0.74, cy: 0.735, chipAnchor: 0 },
    ],
    10: [
      { x: 0.5, y: 0.956, ax: 0.5, ay: 1, cx: 0.5, cy: 0.655, chipAnchor: 0 },
      { x: 0.165, y: 0.925, ax: 0.5, ay: 1, cx: 0.26, cy: 0.735, chipAnchor: 0 },
      { x: 0.05, y: 0.615, ax: 0, ay: 0.5, cx: 0.215, cy: 0.615, chipAnchor: 1 },
      { x: 0.05, y: 0.385, ax: 0, ay: 0.5, cx: 0.215, cy: 0.385, chipAnchor: 1 },
      { x: 0.277, y: 0.075, ax: 0.5, ay: 0, cx: 0.277, cy: 0.29, chipAnchor: 0 },
      { x: 0.5, y: 0.075, ax: 0.5, ay: 0, cx: 0.5, cy: 0.29, chipAnchor: 0 },
      { x: 0.723, y: 0.075, ax: 0.5, ay: 0, cx: 0.723, cy: 0.29, chipAnchor: 0 },
      { x: 0.95, y: 0.385, ax: 1, ay: 0.5, cx: 0.785, cy: 0.385, chipAnchor: -1 },
      { x: 0.95, y: 0.615, ax: 1, ay: 0.5, cx: 0.785, cy: 0.615, chipAnchor: -1 },
      { x: 0.835, y: 0.925, ax: 0.5, ay: 1, cx: 0.74, cy: 0.735, chipAnchor: 0 },
    ],
  },
  /* 2:3 — a phone held upright. The board is one row of five as wide as the table, so no seat sits level with it: the flanks are above and below it, and a full ring puts four across the top. */
  tall: {
    2: [
      { x: 0.5, y: 0.95, ax: 0.5, ay: 1, cx: 0.5, cy: 0.725, chipAnchor: 0 },
      { x: 0.5, y: 0.05, ax: 0.5, ay: 0, cx: 0.5, cy: 0.286, chipAnchor: 0 },
    ],
    3: [
      { x: 0.5, y: 0.95, ax: 0.5, ay: 1, cx: 0.5, cy: 0.725, chipAnchor: 0 },
      { x: 0.02, y: 0.33, ax: 0, ay: 0.5, cx: 0.26, cy: 0.31, chipAnchor: 1 },
      { x: 0.98, y: 0.33, ax: 1, ay: 0.5, cx: 0.74, cy: 0.31, chipAnchor: -1 },
    ],
    4: [
      { x: 0.5, y: 0.95, ax: 0.5, ay: 1, cx: 0.5, cy: 0.725, chipAnchor: 0 },
      { x: 0.02, y: 0.33, ax: 0, ay: 0.5, cx: 0.26, cy: 0.31, chipAnchor: 1 },
      { x: 0.5, y: 0.05, ax: 0.5, ay: 0, cx: 0.5, cy: 0.283, chipAnchor: 0 },
      { x: 0.98, y: 0.33, ax: 1, ay: 0.5, cx: 0.74, cy: 0.31, chipAnchor: -1 },
    ],
    5: [
      { x: 0.5, y: 0.95, ax: 0.5, ay: 1, cx: 0.5, cy: 0.725, chipAnchor: 0 },
      { x: 0.02, y: 0.665, ax: 0, ay: 0.5, cx: 0.26, cy: 0.645, chipAnchor: 1 },
      { x: 0.02, y: 0.335, ax: 0, ay: 0.5, cx: 0.26, cy: 0.31, chipAnchor: 1 },
      { x: 0.98, y: 0.335, ax: 1, ay: 0.5, cx: 0.74, cy: 0.31, chipAnchor: -1 },
      { x: 0.98, y: 0.665, ax: 1, ay: 0.5, cx: 0.74, cy: 0.645, chipAnchor: -1 },
    ],
    6: [
      { x: 0.5, y: 0.95, ax: 0.5, ay: 1, cx: 0.5, cy: 0.725, chipAnchor: 0 },
      { x: 0.02, y: 0.665, ax: 0, ay: 0.5, cx: 0.26, cy: 0.645, chipAnchor: 1 },
      { x: 0.02, y: 0.335, ax: 0, ay: 0.5, cx: 0.26, cy: 0.31, chipAnchor: 1 },
      { x: 0.5, y: 0.05, ax: 0.5, ay: 0, cx: 0.5, cy: 0.283, chipAnchor: 0 },
      { x: 0.98, y: 0.335, ax: 1, ay: 0.5, cx: 0.74, cy: 0.31, chipAnchor: -1 },
      { x: 0.98, y: 0.665, ax: 1, ay: 0.5, cx: 0.74, cy: 0.645, chipAnchor: -1 },
    ],
    7: [
      { x: 0.5, y: 0.95, ax: 0.5, ay: 1, cx: 0.5, cy: 0.725, chipAnchor: 0 },
      { x: 0.02, y: 0.665, ax: 0, ay: 0.5, cx: 0.26, cy: 0.645, chipAnchor: 1 },
      { x: 0.02, y: 0.335, ax: 0, ay: 0.5, cx: 0.26, cy: 0.31, chipAnchor: 1 },
      { x: 0.348, y: 0.05, ax: 0.5, ay: 0, cx: 0.348, cy: 0.25, chipAnchor: 0 },
      { x: 0.653, y: 0.05, ax: 0.5, ay: 0, cx: 0.653, cy: 0.25, chipAnchor: 0 },
      { x: 0.98, y: 0.335, ax: 1, ay: 0.5, cx: 0.74, cy: 0.31, chipAnchor: -1 },
      { x: 0.98, y: 0.665, ax: 1, ay: 0.5, cx: 0.74, cy: 0.645, chipAnchor: -1 },
    ],
    8: [
      { x: 0.5, y: 0.95, ax: 0.5, ay: 1, cx: 0.5, cy: 0.725, chipAnchor: 0 },
      { x: 0.02, y: 0.7, ax: 0, ay: 0.5, cx: 0.26, cy: 0.645, chipAnchor: 1 },
      { x: 0.02, y: 0.33, ax: 0, ay: 0.5, cx: 0.26, cy: 0.31, chipAnchor: 1 },
      { x: 0.2, y: 0.05, ax: 0.5, ay: 0, cx: 0.38, cy: 0.24, chipAnchor: -1 },
      { x: 0.5, y: 0.05, ax: 0.5, ay: 0, cx: 0.5, cy: 0.29, chipAnchor: 0 },
      { x: 0.8, y: 0.05, ax: 0.5, ay: 0, cx: 0.62, cy: 0.24, chipAnchor: 1 },
      { x: 0.98, y: 0.33, ax: 1, ay: 0.5, cx: 0.74, cy: 0.31, chipAnchor: -1 },
      { x: 0.98, y: 0.7, ax: 1, ay: 0.5, cx: 0.74, cy: 0.645, chipAnchor: -1 },
    ],
    9: [
      { x: 0.5, y: 0.95, ax: 0.5, ay: 1, cx: 0.5, cy: 0.725, chipAnchor: 0 },
      { x: 0.02, y: 0.7, ax: 0, ay: 0.5, cx: 0.26, cy: 0.645, chipAnchor: 1 },
      { x: 0.02, y: 0.33, ax: 0, ay: 0.5, cx: 0.26, cy: 0.31, chipAnchor: 1 },
      { x: 0.14, y: 0.05, ax: 0.5, ay: 0, cx: 0.14, cy: 0.235, chipAnchor: 0 },
      { x: 0.38, y: 0.05, ax: 0.5, ay: 0, cx: 0.38, cy: 0.235, chipAnchor: 0 },
      { x: 0.62, y: 0.05, ax: 0.5, ay: 0, cx: 0.62, cy: 0.235, chipAnchor: 0 },
      { x: 0.86, y: 0.05, ax: 0.5, ay: 0, cx: 0.86, cy: 0.235, chipAnchor: 0 },
      { x: 0.98, y: 0.33, ax: 1, ay: 0.5, cx: 0.74, cy: 0.31, chipAnchor: -1 },
      { x: 0.98, y: 0.7, ax: 1, ay: 0.5, cx: 0.74, cy: 0.645, chipAnchor: -1 },
    ],
    10: [
      { x: 0.5, y: 0.95, ax: 0.5, ay: 1, cx: 0.5, cy: 0.725, chipAnchor: 0 },
      { x: 0.02, y: 0.95, ax: 0, ay: 1, cx: 0.125, cy: 0.79, chipAnchor: 0 },
      { x: 0.02, y: 0.7, ax: 0, ay: 0.5, cx: 0.26, cy: 0.645, chipAnchor: 1 },
      { x: 0.02, y: 0.33, ax: 0, ay: 0.5, cx: 0.26, cy: 0.31, chipAnchor: 1 },
      { x: 0.14, y: 0.05, ax: 0.5, ay: 0, cx: 0.14, cy: 0.235, chipAnchor: 0 },
      { x: 0.38, y: 0.05, ax: 0.5, ay: 0, cx: 0.38, cy: 0.235, chipAnchor: 0 },
      { x: 0.62, y: 0.05, ax: 0.5, ay: 0, cx: 0.62, cy: 0.235, chipAnchor: 0 },
      { x: 0.86, y: 0.05, ax: 0.5, ay: 0, cx: 0.86, cy: 0.235, chipAnchor: 0 },
      { x: 0.98, y: 0.33, ax: 1, ay: 0.5, cx: 0.74, cy: 0.31, chipAnchor: -1 },
      { x: 0.98, y: 0.7, ax: 1, ay: 0.5, cx: 0.74, cy: 0.645, chipAnchor: -1 },
    ],
  },
  /* 1:1 — a small embed. Badge seats: the plate is legible, the hand is not. */
  compact: {
    2: [
      { x: 0.5, y: 0.96, ax: 0.5, ay: 1, cx: 0.72, cy: 0.8, chipAnchor: 0 },
      { x: 0.5, y: 0.04, ax: 0.5, ay: 0, cx: 0.66, cy: 0.26, chipAnchor: 0 },
    ],
    3: [
      { x: 0.5, y: 0.96, ax: 0.5, ay: 1, cx: 0.72, cy: 0.8, chipAnchor: 0 },
      { x: 0.015, y: 0.5, ax: 0, ay: 0.5, cx: 0.284, cy: 0.5, chipAnchor: 1 },
      { x: 0.985, y: 0.5, ax: 1, ay: 0.5, cx: 0.717, cy: 0.5, chipAnchor: -1 },
    ],
    4: [
      { x: 0.5, y: 0.96, ax: 0.5, ay: 1, cx: 0.72, cy: 0.8, chipAnchor: 0 },
      { x: 0.015, y: 0.5, ax: 0, ay: 0.5, cx: 0.284, cy: 0.5, chipAnchor: 1 },
      { x: 0.5, y: 0.04, ax: 0.5, ay: 0, cx: 0.66, cy: 0.26, chipAnchor: 0 },
      { x: 0.985, y: 0.5, ax: 1, ay: 0.5, cx: 0.717, cy: 0.5, chipAnchor: -1 },
    ],
    5: [
      { x: 0.5, y: 0.96, ax: 0.5, ay: 1, cx: 0.72, cy: 0.8, chipAnchor: 0 },
      { x: 0.015, y: 0.675, ax: 0, ay: 0.5, cx: 0.279, cy: 0.675, chipAnchor: 1 },
      { x: 0.015, y: 0.325, ax: 0, ay: 0.5, cx: 0.279, cy: 0.325, chipAnchor: 1 },
      { x: 0.985, y: 0.325, ax: 1, ay: 0.5, cx: 0.722, cy: 0.325, chipAnchor: -1 },
      { x: 0.985, y: 0.675, ax: 1, ay: 0.5, cx: 0.722, cy: 0.675, chipAnchor: -1 },
    ],
    6: [
      { x: 0.5, y: 0.96, ax: 0.5, ay: 1, cx: 0.72, cy: 0.8, chipAnchor: 0 },
      { x: 0.015, y: 0.675, ax: 0, ay: 0.5, cx: 0.279, cy: 0.675, chipAnchor: 1 },
      { x: 0.015, y: 0.325, ax: 0, ay: 0.5, cx: 0.279, cy: 0.325, chipAnchor: 1 },
      { x: 0.5, y: 0.04, ax: 0.5, ay: 0, cx: 0.66, cy: 0.26, chipAnchor: 0 },
      { x: 0.985, y: 0.325, ax: 1, ay: 0.5, cx: 0.722, cy: 0.325, chipAnchor: -1 },
      { x: 0.985, y: 0.675, ax: 1, ay: 0.5, cx: 0.722, cy: 0.675, chipAnchor: -1 },
    ],
    7: [
      { x: 0.5, y: 0.96, ax: 0.5, ay: 1, cx: 0.72, cy: 0.8, chipAnchor: 0 },
      { x: 0.015, y: 0.675, ax: 0, ay: 0.5, cx: 0.274, cy: 0.675, chipAnchor: 1 },
      { x: 0.015, y: 0.325, ax: 0, ay: 0.5, cx: 0.274, cy: 0.325, chipAnchor: 1 },
      { x: 0.335, y: 0.04, ax: 0.5, ay: 0, cx: 0.335, cy: 0.261, chipAnchor: 0 },
      { x: 0.665, y: 0.04, ax: 0.5, ay: 0, cx: 0.665, cy: 0.261, chipAnchor: 0 },
      { x: 0.985, y: 0.325, ax: 1, ay: 0.5, cx: 0.727, cy: 0.325, chipAnchor: -1 },
      { x: 0.985, y: 0.675, ax: 1, ay: 0.5, cx: 0.727, cy: 0.675, chipAnchor: -1 },
    ],
    8: [
      { x: 0.5, y: 0.96, ax: 0.5, ay: 1, cx: 0.72, cy: 0.8, chipAnchor: 0 },
      { x: 0.015, y: 0.733, ax: 0, ay: 0.5, cx: 0.274, cy: 0.733, chipAnchor: 1 },
      { x: 0.015, y: 0.5, ax: 0, ay: 0.5, cx: 0.274, cy: 0.5, chipAnchor: 1 },
      { x: 0.015, y: 0.267, ax: 0, ay: 0.5, cx: 0.274, cy: 0.267, chipAnchor: 1 },
      { x: 0.5, y: 0.04, ax: 0.5, ay: 0, cx: 0.66, cy: 0.26, chipAnchor: 0 },
      { x: 0.985, y: 0.267, ax: 1, ay: 0.5, cx: 0.727, cy: 0.267, chipAnchor: -1 },
      { x: 0.985, y: 0.5, ax: 1, ay: 0.5, cx: 0.727, cy: 0.5, chipAnchor: -1 },
      { x: 0.985, y: 0.733, ax: 1, ay: 0.5, cx: 0.727, cy: 0.733, chipAnchor: -1 },
    ],
    9: [
      { x: 0.5, y: 0.96, ax: 0.5, ay: 1, cx: 0.72, cy: 0.8, chipAnchor: 0 },
      { x: 0.015, y: 0.733, ax: 0, ay: 0.5, cx: 0.269, cy: 0.733, chipAnchor: 1 },
      { x: 0.015, y: 0.5, ax: 0, ay: 0.5, cx: 0.269, cy: 0.5, chipAnchor: 1 },
      { x: 0.015, y: 0.267, ax: 0, ay: 0.5, cx: 0.269, cy: 0.267, chipAnchor: 1 },
      { x: 0.335, y: 0.04, ax: 0.5, ay: 0, cx: 0.335, cy: 0.256, chipAnchor: 0 },
      { x: 0.665, y: 0.04, ax: 0.5, ay: 0, cx: 0.665, cy: 0.256, chipAnchor: 0 },
      { x: 0.985, y: 0.267, ax: 1, ay: 0.5, cx: 0.732, cy: 0.267, chipAnchor: -1 },
      { x: 0.985, y: 0.5, ax: 1, ay: 0.5, cx: 0.732, cy: 0.5, chipAnchor: -1 },
      { x: 0.985, y: 0.733, ax: 1, ay: 0.5, cx: 0.732, cy: 0.733, chipAnchor: -1 },
    ],
    10: [
      { x: 0.5, y: 0.96, ax: 0.5, ay: 1, cx: 0.72, cy: 0.8, chipAnchor: 0 },
      { x: 0.015, y: 0.763, ax: 0, ay: 0.5, cx: 0.269, cy: 0.763, chipAnchor: 1 },
      { x: 0.015, y: 0.588, ax: 0, ay: 0.5, cx: 0.269, cy: 0.588, chipAnchor: 1 },
      { x: 0.015, y: 0.413, ax: 0, ay: 0.5, cx: 0.269, cy: 0.413, chipAnchor: 1 },
      { x: 0.015, y: 0.238, ax: 0, ay: 0.5, cx: 0.269, cy: 0.238, chipAnchor: 1 },
      { x: 0.5, y: 0.04, ax: 0.5, ay: 0, cx: 0.66, cy: 0.26, chipAnchor: 0 },
      { x: 0.985, y: 0.238, ax: 1, ay: 0.5, cx: 0.732, cy: 0.238, chipAnchor: -1 },
      { x: 0.985, y: 0.413, ax: 1, ay: 0.5, cx: 0.732, cy: 0.413, chipAnchor: -1 },
      { x: 0.985, y: 0.588, ax: 1, ay: 0.5, cx: 0.732, cy: 0.588, chipAnchor: -1 },
      { x: 0.985, y: 0.763, ax: 1, ay: 0.5, cx: 0.732, cy: 0.763, chipAnchor: -1 },
    ],
  },
};

/**
 * How small a stage has to get before it stops being a table with a ratio and
 * starts being a token. Below this the seats are badges: the plate is legible
 * and the hand is not.
 *
 * Both conditions are needed. A 560x280 feed strip is not compact — it is a
 * wide table that happens to be short, and squaring it off would throw away
 * half the width it has. A 300x300 embed genuinely is.
 */
const COMPACT_SHORT_SIDE = 240;
const COMPACT_BOX = 320;

/**
 * Where one shape stops using the stage better than the next.
 *
 * A letterboxed box of ratio `s` inside a stage of ratio `a` uses
 * `min(a/s, s/a)` of it, so two neighbouring shapes are equally good at
 * `a = sqrt(s1 * s2)` and the cut belongs exactly there: 16/9 against 4/3 is
 * 1.54, and 4/3 against 2/3 is 0.94. Picked by measurement rather than by eye,
 * because "which shape" is also "how much of the screen the felt gets".
 */
const WIDE_AT = 1.54;
const CLASSIC_AT = 0.94;

/**
 * The shape the stage should draw.
 *
 * Decided here rather than in a media query, and here rather than in CSS at
 * all, because the slot table needs the same answer: two derivations of
 * "which shape is this" would drift the first time one of them was tuned.
 */
export function shapeFor(width: number, height: number): TableShape {
  if (width <= 0 || height <= 0) {
    return "classic";
  }
  if (
    Math.min(width, height) < COMPACT_SHORT_SIDE ||
    (width < COMPACT_BOX && height < COMPACT_BOX)
  ) {
    return "compact";
  }
  const ratio = width / height;
  if (ratio >= WIDE_AT) {
    return "wide";
  }
  return ratio >= CLASSIC_AT ? "classic" : "tall";
}

/** Seat counts the tables cover; anything outside is clamped onto the ends. */
export function clampSeatCount(count: number): number {
  return Math.max(2, Math.min(10, Math.round(count) || 2));
}

export function crowdFor(count: number): SeatCrowd {
  return CROWD[clampSeatCount(count)];
}

export function seatSizeFor(shape: TableShape, count: number): readonly [number, number] {
  return SEAT_SIZE[shape][crowdFor(count)];
}

export function slotsFor(shape: TableShape, count: number): SeatSlot[] {
  return SEAT_SLOTS[shape][clampSeatCount(count)];
}

/**
 * Which slot a seat sits in.
 *
 * Slot 0 is the focused seat, so the ring is rotated until the hero is at the
 * bottom and everyone else keeps their real clockwise order around him.
 */
export function slotIndex(index: number, heroIndex: number, count: number): number {
  return (index - heroIndex + count) % count;
}
