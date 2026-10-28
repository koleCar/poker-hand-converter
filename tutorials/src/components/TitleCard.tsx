// The opening card: the mark drawn in, the tutorial's title, what it covers
// and where the feature lives.

import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';

import { EASE_OUT, color, font, radius } from '../theme';
import { Backdrop } from './Backdrop';
import { RailMark } from './RailMark';

export function TitleCard({ title, subtitle, where, index }: { title: string; subtitle: string; where: string; index: string }) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const ease = Easing.bezier(...EASE_OUT);
  const mark = interpolate(frame, [0, 28], [0, 1], { extrapolateRight: 'clamp', easing: ease });
  const rise = (start: number) => ({
    opacity: interpolate(frame, [start, start + 14], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
    transform: `translateY(${interpolate(frame, [start, start + 18], [24, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
      easing: ease,
    })}px)`,
  });
  const out = interpolate(frame, [durationInFrames - 12, durationInFrames], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <AbsoluteFill style={{ fontFamily: font.sans, color: color.text }}>
      <Backdrop />
      <AbsoluteFill style={{ opacity: out, padding: '0 180px', justifyContent: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 22, ...rise(4) }}>
          <RailMark size={84} progress={mark} />
          <span style={{ fontSize: 44, fontWeight: 750, letterSpacing: '-0.02em' }}>rail</span>
          <span
            style={{
              marginLeft: 18,
              fontSize: 22,
              fontWeight: 600,
              color: color.textSecondary,
              border: `1px solid ${color.borderStrong}`,
              borderRadius: radius.pill,
              padding: '6px 16px',
            }}
          >
            Tutorial {index}
          </span>
        </div>
        <h1 style={{ margin: '56px 0 0', fontSize: 96, lineHeight: 1.04, fontWeight: 750, letterSpacing: '-0.03em', ...rise(12) }}>
          {title}
        </h1>
        <p style={{ margin: '28px 0 0', fontSize: 38, lineHeight: 1.3, color: color.textSecondary, maxWidth: 1350, ...rise(20) }}>
          {subtitle}
        </p>
        <div style={{ marginTop: 48, display: 'flex', alignItems: 'center', gap: 16, ...rise(28) }}>
          <span style={{ width: 10, height: 10, borderRadius: 5, background: color.accent }} />
          <span style={{ fontSize: 28, fontFamily: font.mono, color: color.accentSoft }}>{where}</span>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
