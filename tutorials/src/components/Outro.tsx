// The closing card: what was covered, and which tutorial comes next.

import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from 'remotion';

import { EASE_OUT, color, font, radius } from '../theme';
import { Backdrop } from './Backdrop';
import { RailMark } from './RailMark';

export function Outro({ title, recap, next }: { title: string; recap: string[]; next?: string }) {
  const frame = useCurrentFrame();
  const ease = Easing.bezier(...EASE_OUT);
  const fadeIn = interpolate(frame, [0, 12], [0, 1], { extrapolateRight: 'clamp' });
  const item = (i: number) => ({
    opacity: interpolate(frame, [8 + i * 5, 20 + i * 5], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
    transform: `translateX(${interpolate(frame, [8 + i * 5, 26 + i * 5], [-20, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
      easing: ease,
    })}px)`,
  });
  return (
    <AbsoluteFill style={{ fontFamily: font.sans, color: color.text, opacity: fadeIn }}>
      <Backdrop />
      <AbsoluteFill style={{ padding: '0 180px', justifyContent: 'center' }}>
        <div style={{ fontSize: 30, color: color.textSecondary, fontWeight: 600 }}>That was</div>
        <div style={{ fontSize: 76, fontWeight: 750, letterSpacing: '-0.03em', marginTop: 8 }}>{title}</div>
        <ul style={{ listStyle: 'none', padding: 0, margin: '44px 0 0', display: 'grid', gap: 18 }}>
          {recap.map((line, i) => (
            <li key={line} style={{ display: 'flex', gap: 18, alignItems: 'baseline', fontSize: 32, ...item(i) }}>
              <span style={{ color: color.accent, fontWeight: 750 }}>{String(i + 1).padStart(2, '0')}</span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
        {next ? (
          <div
            style={{
              marginTop: 64,
              alignSelf: 'flex-start',
              display: 'flex',
              alignItems: 'center',
              gap: 18,
              padding: '18px 28px',
              borderRadius: radius.md,
              background: color.raised,
              border: `1px solid ${color.border}`,
              fontSize: 30,
              ...item(recap.length + 1),
            }}
          >
            <span style={{ color: color.textSecondary }}>Next tutorial</span>
            <span style={{ fontWeight: 650 }}>{next}</span>
            <span style={{ color: color.accent }}>→</span>
          </div>
        ) : null}
      </AbsoluteFill>
      <div style={{ position: 'absolute', right: 80, bottom: 64, display: 'flex', alignItems: 'center', gap: 14, opacity: 0.85 }}>
        <RailMark size={44} />
        <span style={{ fontSize: 30, fontWeight: 750 }}>rail</span>
      </div>
    </AbsoluteFill>
  );
}
