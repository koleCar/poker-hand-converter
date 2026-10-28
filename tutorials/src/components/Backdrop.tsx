// The page behind everything: the app's base surface with its two soft
// glows (tokens: --surface-glow-1/2), as the web's shell paints it.

import { AbsoluteFill } from 'remotion';

import { color } from '../theme';

export function Backdrop() {
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(1200px 700px at 15% 0%, ${color.glow2}, transparent 70%),
          radial-gradient(1000px 800px at 100% 100%, ${color.glow1}, transparent 70%), ${color.bg}`,
      }}
    />
  );
}
