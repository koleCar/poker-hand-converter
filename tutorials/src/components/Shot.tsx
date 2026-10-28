// One screenshot under a camera: placed so the view's point is the frame's
// centre at the view's zoom. Layers (the HUD's overlay) sit on it.

import { AbsoluteFill, Img } from 'remotion';

import { HEIGHT, WIDTH, type View } from '../camera';
import { shotUrl, type ShotRecord } from '../manifest';

export function Shot({
  slug,
  shot,
  view,
  opacity = 1,
  layerOpacity = 1,
}: {
  slug: string;
  shot: ShotRecord;
  view: View;
  opacity?: number;
  layerOpacity?: number;
}) {
  const x = WIDTH / 2 - view.cx * view.zoom;
  const y = HEIGHT / 2 - view.cy * view.zoom;
  const place = {
    position: 'absolute' as const,
    left: 0,
    top: 0,
    width: shot.width,
    height: shot.height,
  };
  return (
    <AbsoluteFill style={{ opacity, overflow: 'hidden' }}>
      <div
        style={{
          ...place,
          transform: `translate(${x}px, ${y}px) scale(${view.zoom})`,
          transformOrigin: '0 0',
          boxShadow: '0 30px 90px rgb(0 0 0 / 55%)',
          borderRadius: 6 / view.zoom,
          overflow: 'hidden',
        }}
      >
        <Img src={shotUrl(slug, shot.file)} style={place} />
        {(shot.layers ?? []).map((file) => (
          <Img key={file} src={shotUrl(slug, file)} style={{ ...place, opacity: layerOpacity }} />
        ))}
      </div>
    </AbsoluteFill>
  );
}
