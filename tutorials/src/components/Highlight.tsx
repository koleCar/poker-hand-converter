// What a step points at: the rest of the picture dimmed, the target(s)
// outlined in the accent colour, and an optional callout beside the first.

import { useId } from 'react';
import { AbsoluteFill } from 'remotion';

import { HEIGHT, WIDTH } from '../camera';
import type { Box } from '../manifest';
import { color, font, radius } from '../theme';

const PAD = 12;

export function Highlight({ boxes, strength, callout }: { boxes: Box[]; strength: number; callout?: string }) {
  const id = `spot-${useId().replace(/:/g, '')}`;
  if (!boxes.length || strength <= 0) return null;
  const padded = boxes.map((b) => ({ x: b.x - PAD, y: b.y - PAD, w: b.w + 2 * PAD, h: b.h + 2 * PAD }));
  const first = padded[0];
  // The callout goes above the box, or below it when there is no room.
  const above = first.y > 120;
  const calloutY = above ? first.y - 64 : first.y + first.h + 14;
  const calloutX = Math.min(Math.max(first.x, 40), WIDTH - 640);
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <svg width={WIDTH} height={HEIGHT} style={{ position: 'absolute', inset: 0 }}>
        <defs>
          <mask id={id}>
            <rect width={WIDTH} height={HEIGHT} fill="white" />
            {padded.map((b, i) => (
              <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} rx={14} fill="black" />
            ))}
          </mask>
        </defs>
        <rect width={WIDTH} height={HEIGHT} fill="rgb(5 8 12)" opacity={0.52 * strength} mask={`url(#${id})`} />
        {padded.map((b, i) => (
          <rect
            key={i}
            x={b.x}
            y={b.y}
            width={b.w}
            height={b.h}
            rx={14}
            fill="none"
            stroke="var(--a-400)"
            strokeWidth={4}
            opacity={strength}
            style={{ filter: 'drop-shadow(0 0 14px rgb(62 166 255 / 55%))' }}
          />
        ))}
      </svg>
      {callout ? (
        <div
          style={{
            position: 'absolute',
            left: calloutX,
            top: calloutY,
            opacity: strength,
            padding: '10px 18px',
            borderRadius: radius.sm,
            background: color.accent,
            color: color.onAccent,
            fontFamily: font.sans,
            fontSize: 26,
            fontWeight: 650,
            boxShadow: 'var(--elevation-1)',
            whiteSpace: 'nowrap',
          }}
        >
          {callout}
        </div>
      ) : null}
    </AbsoluteFill>
  );
}
