import { useEffect, useRef, useState } from "react";

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

function reducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(REDUCED_QUERY).matches;
}

/**
 * A figure that counts to its value: up from zero when it first shows, and
 * from the old value to the new one when a filter changes it. Ease-out, so it
 * settles rather than stops. `null` (no figure) passes straight through.
 *
 * Under `prefers-reduced-motion` it is the value, at once.
 */
export function useCountUp(target: number | null, ms = 700): number | null {
  const [shown, setShown] = useState<number | null>(() => (target === null || reducedMotion() ? target : 0));
  const current = useRef<number | null>(shown);

  useEffect(() => {
    const start = current.current;
    let frame = 0;
    if (target === null || start === null || start === target || reducedMotion()) {
      current.current = target;
      frame = requestAnimationFrame(() => setShown(target));
      return () => cancelAnimationFrame(frame);
    }
    const began = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - began) / ms);
      const eased = 1 - (1 - p) ** 3;
      const value = p === 1 ? target : start + (target - start) * eased;
      current.current = value;
      setShown(value);
      if (p < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);

  return target === null ? null : shown;
}
