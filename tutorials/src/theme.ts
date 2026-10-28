// Rail's design tokens, from the shared UI package itself: the token sheets
// are imported (src/index.ts) and the videos paint with their custom
// properties, so a change of brand colour reaches the videos too.

export const color = {
  bg: 'var(--surface-base)',
  sunken: 'var(--surface-sunken)',
  raised: 'var(--surface-raised)',
  raised2: 'var(--surface-raised-2)',
  glow1: 'var(--surface-glow-1)',
  glow2: 'var(--surface-glow-2)',
  border: 'var(--border-default)',
  borderStrong: 'var(--border-strong)',
  text: 'var(--text-primary)',
  textSecondary: 'var(--text-secondary)',
  textTertiary: 'var(--text-tertiary)',
  accent: 'var(--a-400)',
  accentSoft: 'var(--a-300)',
  accentDeep: 'var(--a-700)',
  onAccent: 'var(--text-on-accent)',
  money: 'var(--m-300)',
  felt: 'var(--f-600)',
} as const;

export const font = {
  sans: 'var(--font-family-sans)',
  mono: 'var(--font-family-mono)',
} as const;

export const radius = {
  sm: 'var(--radius-3)',
  md: 'var(--radius-4)',
  lg: 'var(--radius-5)',
  pill: 'var(--radius-pill)',
} as const;

/** `--ease-out` of tokens/motion.css, as Remotion's Easing. */
export const EASE_OUT: [number, number, number, number] = [0.2, 0.9, 0.3, 1];
export const EASE_STANDARD: [number, number, number, number] = [0.2, 0, 0, 1];
