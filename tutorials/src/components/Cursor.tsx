// The pointer and its click: an arrow like the system's, and a ripple in
// the accent colour where it clicks.

import { interpolate } from 'remotion';

import { color } from '../theme';

export function Cursor({ x, y, opacity, pressed }: { x: number; y: number; opacity: number; pressed: number }) {
  const scale = 1 - 0.14 * pressed;
  return (
    <svg
      width={44}
      height={56}
      viewBox="0 0 22 28"
      style={{
        position: 'absolute',
        left: x - 3,
        top: y - 2,
        opacity,
        transform: `scale(${scale})`,
        transformOrigin: '3px 2px',
        filter: 'drop-shadow(0 3px 6px rgb(0 0 0 / 55%))',
      }}
    >
      <path
        d="M1.5 1.5 L1.5 22 L6.6 17.3 L10 25.5 L13.6 24 L10.3 16 L17.5 16 Z"
        fill="#ffffff"
        stroke="#0b0f14"
        strokeWidth={1.6}
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** `age`: frames since the click. */
export function ClickRipple({ x, y, age }: { x: number; y: number; age: number }) {
  if (age < 0 || age > 24) return null;
  const size = interpolate(age, [0, 24], [16, 110]);
  const opacity = interpolate(age, [0, 6, 24], [0, 0.85, 0]);
  return (
    <div
      style={{
        position: 'absolute',
        left: x - size / 2,
        top: y - size / 2,
        width: size,
        height: size,
        borderRadius: '50%',
        border: `4px solid ${color.accent}`,
        background: 'color-mix(in srgb, var(--a-400) 18%, transparent)',
        opacity,
      }}
    />
  );
}
