/**
 * The drop ladder (#19).
 *
 * The information architecture splits on one axis: **if it changes as you
 * scrub, it lives on the felt; if it is constant for the whole hand, it lives
 * one tap away.** That settles *where* a thing goes. This file settles *when*
 * it goes there.
 *
 * Elements are ranked by how often you look at them while scrubbing, and at
 * each size step the lowest-ranked still-visible one is dropped:
 *
 *   1. icon labels        -> icon only        `.rp__opts`
 *   2. speed chips        -> cycling button   `.rp__speed`
 *   3. street labels      -> initials         `.rp__streets`
 *   4. log                -> overlay          always, now
 *   5. showdown strip     -> sheet            always, now
 *   6. hand meta          -> info sheet       `.rp__meta`   <- #58
 *   7. seat name          -> position badge   `@container rpfelt`
 *
 * Rungs 4 and 5 are unconditional since the sheets rebuild: a transcript whose
 * length the hand decides can never be in the layout flow of a box that may
 * not scroll. Rung 7 is the one rung that belongs to the *felt* rather than to
 * the chrome, so it stays a container query on `rpfelt` in the stylesheet —
 * a nine-seat ring runs out of room at a different size than a button row
 * does.
 *
 * Nothing below rung 4 is ever deleted. The meta strip becomes the `i` sheet,
 * the street chips become keys `1`-`5` and the ticks on the rail, the speed
 * chips become one button that cycles. Everything is one gesture away.
 *
 * The critical property is that a dropped item is **gone**, not shrunk. #58 is
 * rung 6 done wrong: `text-overflow: ellipsis` on each meta item turned
 * `PokerStars · Hygiea III · $0.25/$0.50 · NL Hold'em` into
 * `P... · '... · '... · '...`, which reads as a rendering bug rather than as a
 * deliberate omission, and still spent the vertical room.
 *
 * Decided in JS and published as `data-tier`, for the same reason `data-shape`
 * is: the transport has to choose between *two different controls* for speed,
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

/** Rung 2: below `lg` the five speed chips collapse to one cycling button. */
export function speedIsCycled(tier: ReplayTier): boolean {
  return tier !== "lg";
}

/** Rung 3: below `lg` street chips print `P F T R S` instead of full names. */
export function streetsAreInitials(tier: ReplayTier): boolean {
  return tier !== "lg";
}
