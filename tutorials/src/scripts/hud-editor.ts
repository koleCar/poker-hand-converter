// hud-editor: the HUD screen's editor - presets, a design of your own, the
// panel's statistics and their settings, the preview under each room's
// rules, and which design each table gets. A part of the HUD tutorial,
// split off for length; it reads the `hud` captures.

import { hudAppSteps } from './hud-app-steps.ts';
import type { Tutorial } from './types.ts';

export const script: Tutorial = {
  slug: 'hud-editor',
  captures: 'hud',
  title: 'Designing your HUD',
  subtitle: 'Presets, your own panel, and a preview under each room’s rules',
  where: 'Rail desktop app · HUD screen → editor',
  chapters: hudAppSteps.filter((c) => ['Designs', 'The panel', 'Preview and tables'].includes(c.title)),
};
