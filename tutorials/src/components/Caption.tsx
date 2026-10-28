// The lower third: the step's badge and chapter over its caption, sliding in
// when the caption changes.

import { Easing, interpolate } from 'remotion';

import { EASE_OUT, color, font, radius } from '../theme';

export function StepBadge({ index, total, chapter }: { index: number; total: number; chapter: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 22, fontWeight: 650 }}>
      <span
        style={{
          background: color.accent,
          color: color.onAccent,
          borderRadius: radius.pill,
          padding: '4px 14px',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {index} / {total}
      </span>
      <span style={{ color: color.textSecondary, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{chapter}</span>
    </div>
  );
}

/** `age`: frames since this caption appeared; `left`: frames until it goes. */
export function Caption({
  text,
  index,
  total,
  chapter,
  age,
  left,
}: {
  text: string;
  index: number;
  total: number;
  chapter: string;
  age: number;
  left: number;
}) {
  const ease = Easing.bezier(...EASE_OUT);
  const opacity = Math.min(
    interpolate(age, [0, 10], [0, 1], { extrapolateRight: 'clamp' }),
    interpolate(left, [0, 6], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
  );
  const y = interpolate(age, [0, 16], [28, 0], { extrapolateRight: 'clamp', easing: ease });
  return (
    <div
      style={{
        position: 'absolute',
        left: 64,
        right: 64,
        bottom: 44,
        display: 'flex',
        justifyContent: 'flex-start',
        opacity,
        transform: `translateY(${y}px)`,
        fontFamily: font.sans,
      }}
    >
      <div
        style={{
          maxWidth: 1460,
          display: 'grid',
          gap: 12,
          padding: '22px 30px 24px 30px',
          borderRadius: radius.md,
          background: 'color-mix(in srgb, var(--surface-raised) 94%, transparent)',
          border: `1px solid ${color.border}`,
          borderLeft: `6px solid ${color.accent}`,
          boxShadow: 'var(--elevation-2)',
        }}
      >
        <StepBadge index={index} total={total} chapter={chapter} />
        <div style={{ fontSize: 36, lineHeight: 1.3, fontWeight: 500, color: color.text, letterSpacing: '-0.005em' }}>
          {text}
        </div>
      </div>
    </div>
  );
}
