/**
 * A grade as a glyph: the shape carries the grade as much as the colour does,
 * the way annotated chess moves do — `★ ✓ ?! ? ??` from Perfect to Blunder —
 * so the icon still reads in greyscale, in forced colours and for anyone who
 * cannot tell the green from the red.
 *
 * Decorative by default (`aria-hidden`): the chip, row or heading it sits in
 * carries the grade's word. Pass `label` where the icon stands alone.
 */

import styles from "./analysis.module.css";

/** Glyphs, not words: the same in every language. */
const GLYPHS: Record<string, string> = {
  perfect: "★",
  good: "✓",
  inaccurate: "?!",
  mistake: "?",
  blunder: "??",
};

export function GradeIcon({ grade, label }: { grade: string; label?: string }) {
  const glyph = GLYPHS[grade];
  if (!glyph) return null;
  return (
    <span
      className={`${styles.gradeIcon} ${styles[grade] ?? ""}`}
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
    >
      {glyph}
    </span>
  );
}
