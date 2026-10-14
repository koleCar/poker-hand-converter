/**
 * Chips that travel between two places on the felt.
 *
 * Two of them: the sweep from the bet ring into the middle at the end of a
 * street, and the pot going out to a winner on an award frame. Both interpolate
 * between two *computed layout positions* — a seat's designed chip spot from
 * the slot table, and wherever the pot pile ended up once the board, the pot
 * pills and the container queries had their say.
 *
 * That is why this is WAAPI and not `@keyframes`. A CSS animation between two
 * `calc()` values has to be written before either value is known, it re-reads
 * them on every resize (so a stack mid-flight jumps when the window moves),
 * and there is no way to stop one cleanly — `animation: none` yanks the
 * element back to its start, which for a chip halfway across the table is the
 * wrong end. `element.animate(...)` measures both ends at the moment the
 * flight starts, and hands back an `Animation` with `finish()` on it, which is
 * precisely the escape hatch scrubbing needs: on any non-step transition the
 * replayer finishes everything in flight and the felt is instantly consistent.
 *
 * Measured FLIP-style rather than computed from the slot fractions. The slots
 * are fractions of the felt box and the pot pile is laid out by flexbox inside
 * a container query, so only one of the two ends is knowable in the slot
 * table's terms; a `getBoundingClientRect()` on each end knows both, at the
 * size they are actually being drawn.
 */

import { useLayoutEffect, useRef, type ReactNode } from "react";
import { durationToken, easingToken } from "./motionTokens";

/**
 * Which way the chips are going.
 *
 * `"to-pot"` — out of a seat's chip spot into the middle, fading as it lands,
 * because the pot pill has already grown by the same amount.
 * `"from-pot"` — out of the middle to a winner's chip spot: the pot pill has
 * already shrunk, so the chips fade *in* off the pile and fade out again as
 * they arrive on the stack that just grew.
 */
export type ChipFlight = "to-pot" | "from-pot";

interface TravellingChipsProps {
  flight: ChipFlight;
  /** The pile in the middle. The other end of every flight. */
  anchorRef: React.RefObject<HTMLElement | null>;
  /**
   * Whether the chips may actually move.
   *
   * False under `prefers-reduced-motion`, where the flight degrades to the
   * opacity half of itself. Deleting it outright — which is what the
   * stylesheet used to do — loses the one thing it carries: the sweep is how
   * a reader learns *whose* chips went in, and a pot that is simply gone from
   * the middle never says who it went to.
   */
  positional: boolean;
  className: string;
  style: React.CSSProperties;
  children: ReactNode;
}

/** Centre of a box, in client coordinates. */
function centre(el: Element): { x: number; y: number } {
  const box = el.getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

const TIMING: Record<ChipFlight, { duration: string; fallbackMs: number; easing: string; fallbackEase: string }> = {
  // Leaving: a pot sweeping across the table, and it may accelerate away.
  "to-pot": {
    duration: "--dur-6",
    fallbackMs: 460,
    easing: "--ease-in",
    fallbackEase: "cubic-bezier(0.6, 0, 1, 0.6)",
  },
  // Arriving: the longest thing allowed, decelerating onto the stack. This is
  // the beat that answers "who won it", and it is paid once per pot.
  "from-pot": {
    duration: "--dur-7",
    fallbackMs: 700,
    easing: "--ease-standard",
    fallbackEase: "cubic-bezier(0.2, 0, 0, 1)",
  },
};

export function TravellingChips({
  flight,
  anchorRef,
  positional,
  className,
  style,
  children,
}: TravellingChipsProps) {
  const ref = useRef<HTMLDivElement | null>(null);

  // Mount-only on purpose. The element is keyed on the frame it belongs to, so
  // a new flight is a new element; a re-render for any other reason (the bb
  // toggle, a resize) must not restart one already under way.
  useLayoutEffect(() => {
    const el = ref.current;
    const anchor = anchorRef.current;
    if (!el || typeof el.animate !== "function") {
      return;
    }

    const timing = TIMING[flight];
    const duration = durationToken(el, timing.duration, timing.fallbackMs);
    const easing = easingToken(el, timing.easing, timing.fallbackEase);

    // The element is laid out at its *own* end of the flight — the seat's chip
    // spot — so the offset to the middle is the whole journey, and `transform`
    // is free to carry it: `translate` is the property the slot table uses to
    // hang a stack off its spot, and a flight must not be able to clobber it.
    //
    // Without it the keyframes are the opacity half alone. Not an identity
    // `translate(0, 0)`, which would be positional motion that happens to
    // cover no distance: nothing should have to inspect the values to see that
    // this mode does not move anything.
    let offset: { home: string; pot: string } | null = null;
    if (positional && anchor) {
      const here = centre(el);
      const there = centre(anchor);
      offset = {
        home: "translate(0, 0)",
        pot: `translate(${there.x - here.x}px, ${there.y - here.y}px)`,
      };
    }

    const frames: Keyframe[] =
      flight === "to-pot"
        ? [
            { ...(offset ? { transform: offset.home } : {}), opacity: 1 },
            { ...(offset ? { transform: offset.pot } : {}), opacity: 0 },
          ]
        : [
            { ...(offset ? { transform: offset.pot } : {}), opacity: 0 },
            { opacity: 1, offset: 0.15 },
            { opacity: 1, offset: 0.82 },
            { ...(offset ? { transform: offset.home } : {}), opacity: 0 },
          ];

    const animation = el.animate(frames, { duration, easing, fill: "forwards" });
    return () => animation.cancel();
  }, [flight, anchorRef, positional]);

  return (
    <div ref={ref} className={className} style={style}>
      {children}
    </div>
  );
}
