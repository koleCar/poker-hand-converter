// hud: the HUD at the table - frames of the real renderer
// (`rail_hud::scene`, via hud/rail-hud/examples/scene_svg.rs) over a drawn
// demo table, never a screen recording - then the app's HUD screen (which
// tables have it and why not) and the popup. The editor is `hud-editor`.
// Shots: capture/hud.ts and capture/desktop/capture.ts.

import { hudAppSteps } from './hud-app-steps.ts';
import type { Chapter, Tutorial } from './types.ts';

const chapter = (title: string): Chapter => {
  const found = hudAppSteps.find((c) => c.title === title);
  if (!found) throw new Error(`hud-app-steps: no chapter ${title}`);
  return found;
};

export const script: Tutorial = {
  slug: 'hud',
  title: 'The HUD',
  subtitle: 'Numbers on every opponent at your tables, only where the room allows it',
  where: 'Rail desktop app · over your tables, and the HUD screen',
  next: 'hud-editor',
  chapters: [
    {
      title: 'On your table',
      steps: [
        {
          shot: 'stars-waiting',
          layers: false,
          caption: 'Open a table of a room that allows a HUD. Rail finds the window and lays a transparent overlay on it.',
          seconds: 4.5,
        },
        {
          shot: 'stars-waiting',
          reveal: true,
          focus: 'status',
          fill: 0.35,
          maxZoom: 0.9,
          highlight: 'status',
          caption: 'Until the table’s first hand is written to disk, the overlay only says it is waiting for it.',
          seconds: 4.5,
        },
        {
          shot: 'stars-6max',
          reveal: true,
          caption: 'After a hand, a panel sits beside every seat, kept clear of the seats and the board.',
          seconds: 5,
        },
        {
          shot: 'stars-6max',
          focus: 'tightRegularPanel',
          fill: 0.45,
          maxZoom: 0.9,
          highlight: 'tightRegularPanel',
          caption: 'Six statistics - VPIP, PFR, 3-bet, fold to 3-bet, flop c-bet, aggression frequency - and the hands counted.',
          seconds: 5.5,
        },
        {
          shot: 'stars-6max',
          focus: 'legend',
          fill: 0.3,
          maxZoom: 0.9,
          highlight: ['legend', 'maniacPanel'],
          caption: 'Colours mean something: blue is low, white normal, orange high. The legend in the corner says so.',
          seconds: 5,
        },
        {
          shot: 'stars-6max',
          focus: 'tinySamplePanel',
          fill: 0.45,
          maxZoom: 0.9,
          highlight: 'tinySamplePanel',
          caption: 'A player with few hands shows dimmer figures: a small sample is not hidden, just marked as unreliable.',
          seconds: 5,
        },
        {
          shot: 'winamax-labels',
          focus: 'loosePassivePanel',
          fill: 0.45,
          maxZoom: 0.9,
          reveal: true,
          highlight: ['loosePassivePanel', 'nitPanel'],
          caption: 'Where a room allows labelling players, as Winamax does, your colour tag, a note mark and your label show too.',
          seconds: 5.5,
        },
        {
          shot: 'acr-9max',
          reveal: true,
          highlight: 'board',
          caption: 'Each room’s rules are applied by the HUD itself: on ACR, panels never cover the room’s own table graphics.',
          seconds: 5,
        },
        {
          shot: 'ggpoker-refused',
          reveal: true,
          caption: 'A room that does not allow a HUD gets none: on GGPoker Rail draws nothing, and there is no override.',
          seconds: 5,
        },
      ],
    },
    chapter('At the tables'),
    chapter('The popup'),
  ],
};
