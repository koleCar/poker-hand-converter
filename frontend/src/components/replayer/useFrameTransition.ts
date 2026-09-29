/**
 * When the replayer is allowed to move.
 *
 * A frame is a complete snapshot of the table, so the UI can render any frame
 * from cold. Motion is the opposite: it is a statement about the *edge* between
 * two frames — these chips left that seat, this card was just dealt — and an
 * edge only exists when the viewer actually crossed it.
 *
 * Hence the rule this module exists to enforce:
 *
 *   **Only a `+1` step plays transition motion. Everything else renders the
 *   destination with motion suppressed.**
 *
 * Jumping twenty frames forward must not sweep chips for a street that was
 * skipped, and jumping backward must not deal every card on the table in
 * again. Both were happening because the animations were tied to *mounting*
 * (a card's deal-in) or to "the previous frame I rendered" (the chip sweep),
 * neither of which knows the difference between playing a hand and scrubbing
 * through one.
 *
 * `prefers-reduced-motion` reduces to the same thing: it is `"none"`
 * permanently, so the suppressed path is the path a reduced-motion reader is
 * on the whole time rather than a second, less-travelled code path that only
 * gets exercised when somebody tests it.
 */

import { useEffect, useState } from "react";

/**
 * `"step"` — the viewer advanced by exactly one frame, so the transition
 * between the last frame and this one is real and may be animated.
 * `"none"` — anything else: a scrub, a jump, a reverse, a fresh mount, or a
 * reader who asked for reduced motion. Render the destination, move nothing.
 */
export type FrameMotion = "step" | "none";

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Live `prefers-reduced-motion`.
 *
 * Read on every change rather than once at mount: the setting is toggled from
 * the OS while the page is open (that is how a reader checks it), and on macOS
 * it is two clicks away from the replayer.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const query = window.matchMedia(REDUCED_QUERY);
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return reduced;
}

/**
 * Whether the frame now on screen was arrived at by a single forward step.
 *
 * Derived during the render that notices the change, not in an effect: an
 * effect would paint the new frame once with the previous frame's answer, and
 * "the previous frame's answer" is exactly the bug — a sweep for a street that
 * was skipped is one frame of wrong motion, and one frame is all it takes to
 * see chips fly out of a seat that never bet.
 */
export function useFrameTransition(index: number): FrameMotion {
  const reduced = useReducedMotion();
  const [seen, setSeen] = useState(index);
  const [motion, setMotion] = useState<FrameMotion>("none");

  let current = motion;
  if (seen !== index) {
    current = index === seen + 1 ? "step" : "none";
    setSeen(index);
    setMotion(current);
  }

  return reduced ? "none" : current;
}
