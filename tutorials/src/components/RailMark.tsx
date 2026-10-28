// The Rail mark: web/src/components/brand/RailMark.tsx's large drawing (the
// rail and the board on the felt), with the board bar and the ring drawn in
// by `progress` for the title card.

export function RailMark({ size, progress = 1, color = 'var(--a-400)' }: { size: number; progress?: number; color?: string }) {
  // The ellipse's circumference (rx 13.5, ry 8), for the draw-in.
  const length = 69;
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} fill="none" stroke={color} strokeWidth={3} aria-hidden>
      <ellipse
        cx="16"
        cy="16"
        rx="13.5"
        ry="8"
        strokeDasharray={length}
        strokeDashoffset={length * (1 - Math.min(1, progress * 1.4))}
        strokeLinecap="round"
      />
      <rect
        x={16 - 4.5 * Math.max(0, (progress - 0.45) / 0.55)}
        y="14.5"
        width={9 * Math.max(0, (progress - 0.45) / 0.55)}
        height="3"
        rx="1.5"
        fill={color}
        stroke="none"
      />
    </svg>
  );
}
