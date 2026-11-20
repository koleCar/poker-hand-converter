/**
 * The drop ladder (#19), and where the transport goes.
 *
 * The information architecture splits on one axis: **if it changes as you
 * scrub, it lives on the felt; if it is constant for the whole hand, it lives
 * one tap away.** That settles *where* a thing goes. This file settles *when*
 * it goes there.
 *
 * Design 7 (round 2) took most of the old rungs away for good rather than per
 * size: there is no caption, no visible scrub rail, no street chips and no
 * speed chips any more. Progress is the fill behind the transport buttons, the
 * street starts are notches on its top edge (keys `1`-`5` still jump), and the
 * speed is one button in the header at every size. What is left to drop:
 *
 *   1. hand meta (the crumbs)  -> info sheet   `.rp__meta`   <- #58
 *   2. the Rail mark on the felt                `@container rpfelt`
 *
 * The critical property is that a dropped item is **gone**, not shrunk. #58 is
 * rung 1 done wrong: `text-overflow: ellipsis` on each crumb turned
 * `PokerStars · Hygiea III · $0.25/$0.50 · NL Hold'em` into
 * `P... · '... · '... · '...`, which reads as a rendering bug rather than as a
 * deliberate omission, and still spent the vertical room.
 *
 * Decided in JS and published as `data-tier` / `data-transport`, for the same
 * reason `data-shape` is: the transport changes *which buttons exist* with the
 * box (two step buttons on a phone, the jumps to either end on a desktop),
 * which no stylesheet can do, and a second derivation in a container query
 * would drift away from this one the first time either was tuned.
 */

/** Which rungs of the ladder have fired. */
export type ReplayTier = "lg" | "md" | "sm";

/**
 * Widths of the replayer's own box, in px at a 16px root.
 *
 * Deliberately measured off the replayer and not the viewport: a replayer
 * embedded in a 480px forum column behaves like a phone without being told it
 * is one.
 */
const MD_AT = 480;
const LG_AT = 608;

export function tierFor(width: number): ReplayTier {
  if (width >= LG_AT) {
    return "lg";
  }
  return width >= MD_AT ? "md" : "sm";
}

/**
 * Where the transport sits, off the replayer's own box.
 *
 * - `strip`: a full-width strip along the bottom, under the felt. A phone held
 *   upright, or any box taller than it is wide — the thumb is at the bottom and
 *   the felt has height to spare.
 * - `corner`: a small glass pill in the bottom-right corner, over the room's
 *   cloth. A phone on its side, or any short wide box: a strip would come out
 *   of the felt's height, which is the one thing that box is short of.
 * - `desk`: the same corner, a size up and with the jumps to either end. A
 *   desktop window, a web page, the desktop app, full screen.
 */
export type TransportLayout = "strip" | "corner" | "desk";

/** Below this height a wide box is a phone on its side, not a desk. */
const DESK_MIN_HEIGHT = 440;

export function transportFor(width: number, height: number): TransportLayout {
  if (width >= LG_AT && height >= DESK_MIN_HEIGHT) {
    return "desk";
  }
  return width > height ? "corner" : "strip";
}
