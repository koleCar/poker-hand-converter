// Every tutorial as a composition: id = the feature's slug (docs/GUIDE.md
// uses the same), 1920 x 1080 at 30 fps, its length from its script.

import { Composition, Folder } from 'remotion';

import { HEIGHT, WIDTH } from './camera';
import { SCRIPTS } from './scripts';
import { FPS } from './scripts/types';
import { TutorialVideo, durationOf, metadata } from './Tutorial';

export function RemotionRoot() {
  return (
    <Folder name="Tutorials">
      {SCRIPTS.map((script) => (
        <Composition
          key={script.slug}
          id={script.slug}
          component={TutorialVideo}
          durationInFrames={durationOf(script)}
          fps={FPS}
          width={WIDTH}
          height={HEIGHT}
          defaultProps={{ slug: script.slug, manifest: null }}
          calculateMetadata={metadata}
        />
      ))}
    </Folder>
  );
}
