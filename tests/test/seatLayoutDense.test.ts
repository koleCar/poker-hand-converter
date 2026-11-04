import { describe, expect, it } from "vitest";

import {
  SHAPE_METRICS,
  seatSizeFor,
  sideChipSlots,
  slotsFor,
  type TableShape,
} from "../../packages/ui/replayer/seatLayout.js";

const SHAPES: TableShape[] = ["wide", "classic", "tall", "compact"];
const COUNTS = [2, 3, 4, 5, 6, 7, 8, 9, 10];
/** The room `sideChipSlots` reserves for a stack, in u. */
const ROOM = 18;

/** A slot's seat block, in u. */
function blockOf(shape: TableShape, count: number, index: number) {
  const { arW, arH } = SHAPE_METRICS[shape];
  const width = 100 * Math.max(1, arW / arH);
  const height = 100 * Math.max(1, arH / arW);
  const [seatW, seatH] = seatSizeFor(shape, count);
  const slot = slotsFor(shape, count)[index];
  const left = slot.x * width - slot.ax * seatW;
  const top = slot.y * height - slot.ay * seatH;
  return { left, right: left + seatW, top, bottom: top + seatH, width, height };
}

describe("dense replayer: bet stacks beside the seats", () => {
  // A ten-seat token-sized table has no room beside the hero: the designed
  // spot stays there (the next test covers that it is never forced).
  it("moves the hero's stack beside the hero at every table shape and count", () => {
    for (const shape of ["wide", "classic", "tall"] as const) {
      for (const count of COUNTS) {
        const designed = slotsFor(shape, count);
        const moved = sideChipSlots(designed, shape, seatSizeFor(shape, count));
        const hero = blockOf(shape, count, 0);
        // Right of the hero's block, at its cards' foot.
        expect(moved[0].chipAnchor, `${shape} ${count}`).toBe(1);
        expect(moved[0].cx * hero.width).toBeGreaterThan(hero.right);
        expect(moved[0].cy * hero.height).toBeGreaterThan(hero.top);
        expect(moved[0].cy * hero.height).toBeLessThan(hero.bottom);
      }
    }
  });

  it("never puts a moved stack's room on a seat or off the felt", () => {
    for (const shape of SHAPES) {
      for (const count of COUNTS) {
        const designed = slotsFor(shape, count);
        const moved = sideChipSlots(designed, shape, seatSizeFor(shape, count));
        moved.forEach((slot, index) => {
          if (slot === designed[index]) return;
          const own = blockOf(shape, count, index);
          const start = slot.cx * own.width;
          const [from, to] = slot.chipAnchor === 1 ? [start, start + ROOM] : [start - ROOM, start];
          expect(from, `${shape} ${count} #${index}`).toBeGreaterThanOrEqual(0);
          expect(to, `${shape} ${count} #${index}`).toBeLessThanOrEqual(own.width);
          designed.forEach((_, other) => {
            const block = blockOf(shape, count, other);
            const sameRow = block.top < own.bottom && block.bottom > own.top;
            const overlaps = block.left < to && block.right > from;
            expect(sameRow && overlaps, `${shape} ${count} #${index} vs #${other}`).toBe(false);
          });
        });
      }
    }
  });

  it("leaves the flank seats' designed spots alone", () => {
    const designed = slotsFor("wide", 6);
    const moved = sideChipSlots(designed, "wide", seatSizeFor("wide", 6));
    // Slots 1, 2, 4 and 5 are the flanks of a six-seat wide table.
    for (const index of [1, 2, 4, 5]) {
      expect(moved[index]).toBe(designed[index]);
    }
    // The top seat's stack goes beside it, to the right.
    expect(moved[3].chipAnchor).toBe(1);
  });
});
