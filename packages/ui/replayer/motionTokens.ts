/**
 * The motion scale, in the form WAAPI wants it.
 *
 * `element.animate(...)` takes a number of milliseconds and a bare easing
 * function, neither of which a stylesheet can hand over — so the values are
 * read back out of the cascade instead of being written twice. The
 * alternative, a `460` in a component beside a `--dur-6` that says `460ms`, is
 * a second copy of the scale that nothing keeps honest.
 */

const MS = /^\s*(-?[\d.]+)\s*(ms|s)?\s*$/;

/**
 * Token cache.
 *
 * Motion tokens are not themed (see `tokens/motion.css`) — a transition does
 * not change speed because the page got lighter — so the first answer is the
 * only answer, and this is asked once per travelling chip.
 */
const tokens = new Map<string, string>();

function token(el: Element, name: string, fallback: string): string {
  const hit = tokens.get(name);
  if (hit !== undefined) {
    return hit;
  }
  const value = getComputedStyle(el).getPropertyValue(name).trim();
  const resolved = value || fallback;
  tokens.set(name, resolved);
  return resolved;
}

/** `--dur-6` -> `460`. Falls back rather than animating for 0ms. */
export function durationToken(el: Element, name: string, fallbackMs: number): number {
  const match = MS.exec(token(el, name, `${fallbackMs}ms`));
  if (!match) {
    return fallbackMs;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value)) {
    return fallbackMs;
  }
  return match[2] === "s" ? value * 1000 : value;
}

export function easingToken(el: Element, name: string, fallback: string): string {
  return token(el, name, fallback);
}

