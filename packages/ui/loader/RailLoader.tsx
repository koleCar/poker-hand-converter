import type { CSSProperties } from "react";
import styles from "./RailLoader.module.css";

/**
 * The loader: the Rail mark, with a light running round the rail while the
 * board breathes.
 *
 *              ╭──━━━━──────────╮
 *             (       ▬▬▬▬        )
 *              ╰─────────────────╯
 *
 * It is the same drawing as `web/src/components/brand/RailMark.tsx` (and the
 * favicon), so waiting looks like the product rather than like a browser. The
 * rail is drawn twice: a faint track, and over it a short arc whose dash offset
 * runs once round the ellipse per cycle. The board bar pulses on the same beat.
 *
 * Three things it does that a plain spinner would not:
 *
 *   - It is invisible for its first 150 ms (`delay`). Most reads finish inside
 *     that, and a loader that flashes for one frame reads as a glitch. The
 *     delay is a CSS animation delay, so there is no timer and no state.
 *   - It is a `role="status"` with an accessible name, so a screen reader hears
 *     "Loading hands…" once instead of nothing.
 *   - Under `prefers-reduced-motion` nothing travels: the mark only fades
 *     gently, which still says "working" without movement.
 *
 * Colour is `currentColor` for the track and the accent for the light, so it
 * sits on any surface in either theme.
 */

/** Rendered size. `inline` sits in a line of text or a button. */
export type RailLoaderSize = "inline" | "small" | "section" | "page";

const PX: Record<RailLoaderSize, number> = { inline: 16, small: 24, section: 40, page: 64 };

/**
 * Below about 20px the mark is drawn heavier (see RailMark), and the dash has
 * to know the ellipse's length. SVG2's `pathLength` on an <ellipse> would do
 * that for us, but older WebKit (the macOS app's webview) ignores it on basic
 * shapes, so the circumference is given here (Ramanujan's approximation).
 */
const GEOMETRY = {
  small: { rx: 13, ry: 7.5, stroke: 3.5, length: 65.57, board: { x: 11.5, y: 14.25, width: 9, height: 3.5, rx: 1.75 } },
  large: { rx: 13.5, ry: 8, stroke: 3, length: 68.65, board: { x: 11.5, y: 14.5, width: 9, height: 3, rx: 1.5 } },
} as const;

interface RailLoaderProps {
  /** Default `section`. */
  size?: RailLoaderSize;
  /**
   * Accessible name, and the visible caption when `showLabel` is set. Always
   * pass the surface's own word for what is loading ("Loading hands…").
   */
  label: string;
  /** Show the label under the mark (or beside it, at `inline`). */
  showLabel?: boolean;
  /** Milliseconds before it appears. Default 150; 0 shows it at once. */
  delay?: number;
  /** Centre it in the space it is given, with some room around it. */
  centered?: boolean;
  className?: string;
}

export function RailLoader({ size = "section", label, showLabel = false, delay = 150, centered = false, className }: RailLoaderProps) {
  const px = PX[size];
  const g = px <= 20 ? GEOMETRY.small : GEOMETRY.large;
  const arc = g.length * 0.28;

  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={showLabel ? undefined : label}
      className={[styles.loader, centered ? styles.centered : "", className ?? ""].filter(Boolean).join(" ")}
      data-size={size}
      style={{ "--loader-delay": `${delay}ms`, "--loader-length": `${g.length}px` } as CSSProperties}
    >
      <svg viewBox="0 0 32 32" width={px} height={px} fill="none" strokeWidth={g.stroke} aria-hidden="true" focusable="false" className={styles.mark}>
        <ellipse className={styles.track} cx="16" cy="16" rx={g.rx} ry={g.ry} stroke="currentColor" />
        <ellipse
          className={styles.light}
          cx="16"
          cy="16"
          rx={g.rx}
          ry={g.ry}
          strokeLinecap="round"
          strokeDasharray={`${arc} ${g.length - arc}`}
        />
        <rect className={styles.board} {...g.board} />
      </svg>
      {showLabel && <span className={styles.label}>{label}</span>}
    </span>
  );
}
