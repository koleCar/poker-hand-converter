// The desktop app's part of the `hud` tutorial - the HUD screen's two views
// (the final design of 2026-11-07): At the tables (the header's pill, which
// design each game gets, the rooms and why a table has no HUD, the macOS
// Accessibility row) and the Editor (presets, a statistic dragged onto the
// panel's grid, the user's own copy, the cell's settings by the cell, the
// preview per room and size, the popup's sections, saving it and a rule at
// the tables), then the HUD popup window. Shots `app-...` from
// `capture/desktop/capture.ts` (`captureHudScreens`), recorded into the
// `hud` tutorial's manifest. Captions follow `app/src/i18n/en.ts`
// (`hudStatus`, `hudEditor`, `hudPopup`).

import type { Chapter } from './types.ts';

export const hudAppSteps: Chapter[] = [
  {
    title: 'At the tables',
    steps: [
      {
        shot: 'app-hud-tables',
        focus: 'header',
        highlight: ['statusPill', 'viewSwitch'],
        fill: 0.8,
        caption: 'The HUD screen’s header says how the HUD is doing - here running on three tables - and switches between the Editor and At the tables.',
        seconds: 5,
      },
      {
        shot: 'app-hud-tables',
        focus: 'games',
        highlight: ['cashCard', 'mttCard', 'spinCard'],
        caption: 'Every table gets its game’s design: cash, tournaments and spins each start from a preset, so there is nothing to set up.',
        seconds: 5,
      },
      {
        shot: 'app-hud-tables',
        focus: 'rooms',
        highlight: ['starsRow', 'winamaxRow'],
        caption: 'Below, the rooms: whether each allows a HUD, and how many of your tables are open there.',
        seconds: 4.5,
      },
      {
        shot: 'app-hud-room-menu',
        focus: 'roomMenu',
        highlight: 'refusedRow',
        callout: 'Prohibited',
        fill: 0.5,
        caption: 'A GGPoker table gets no HUD: GGPoker’s rules do not allow one. The room’s ⋯ links its policy page and the date it was checked.',
        seconds: 5.5,
      },
      {
        shot: 'app-hud-room-menu',
        focus: 'roomMenu',
        highlight: 'noOverride',
        fill: 0.5,
        caption: 'There is no switch to turn the HUD on there, by design: Rail only draws at tables whose room allows it.',
        seconds: 4.5,
      },
      {
        shot: 'app-hud-room-unknown',
        focus: 'roomMenu',
        highlight: 'unknownRow',
        fill: 0.5,
        caption: 'Where a room’s rules are not established, as at WePlay, unknown counts as no.',
        seconds: 4,
      },
      {
        shot: 'app-hud-rooms-why',
        focus: 'explain',
        highlight: ['unknownIsNo', 'stricterOnly'],
        fill: 0.5,
        caption: 'Why can’t I enable the HUD here? Rail keeps each room’s rule from its own pages, and an update of the list can only make it stricter.',
        seconds: 5.5,
      },
      {
        shot: 'app-hud-room-list',
        focus: 'listMenu',
        highlight: ['listSource', 'checkNow'],
        fill: 0.5,
        caption: 'The room list’s ⋯ says which list is in force, and looks for an update.',
        seconds: 4,
      },
      {
        shot: 'app-hud-permission',
        focus: 'permissionInfo',
        highlight: ['statusPill', 'permissionWhy', 'permissionNot'],
        caption: 'On a Mac the HUD reads table windows’ titles, which needs the Accessibility permission. Rail asks only when it would find tables.',
        seconds: 5.5,
      },
      {
        shot: 'app-hud-permission',
        focus: 'permissionRow',
        cursor: 'permissionButton',
        click: true,
        highlight: 'permissionButton',
        fill: 0.7,
        caption: 'Open System Settings shows macOS’s own prompt; switch Rail on there and the screen notices by itself.',
        seconds: 4.5,
      },
    ],
  },
  {
    title: 'Designs',
    steps: [
      {
        shot: 'app-hud-editor',
        focus: 'designBar',
        highlight: ['designPicker', 'formats'],
        fill: 0.8,
        caption: 'The Editor: pick a design - one of the presets, or your own - and the game it is made for.',
        seconds: 4.5,
      },
      {
        shot: 'app-hud-editor',
        highlight: ['panelGrid', 'drawer'],
        caption: 'Below it the panel, slot by slot as the HUD draws it, and its preview; the statistics are in a drawer on the right.',
        seconds: 5,
      },
      {
        shot: 'app-hud-preset-spin',
        focus: 'panelGrid',
        highlight: ['spinFormat', 'panelGrid'],
        fill: 0.5,
        caption: 'Each preset has its own panel. Spin’s is about stealing and defending the blinds: almost every hand is a steal or a defence.',
        seconds: 5,
      },
    ],
  },
  {
    title: 'The panel',
    steps: [
      {
        shot: 'app-hud-panel',
        focus: 'drawer',
        cursor: 'stealRow',
        highlight: 'search',
        fill: 0.6,
        caption: 'Find a statistic narrows the drawer.',
        seconds: 3,
      },
      {
        shot: 'app-hud-drag',
        focus: 'panelBox',
        cursor: 'dropSlot',
        highlight: 'dropSlot',
        fill: 0.5,
        caption: 'Drag it onto the panel: into a slot, or just past the right or bottom edge to add a column or a row.',
        seconds: 4.5,
      },
      {
        shot: 'app-hud-dropped',
        focus: 'panelGrid',
        highlight: ['newCell', 'emptySlot'],
        callout: 'Steal',
        fill: 0.5,
        caption: 'Steal starts a third row. The slots beside it stay empty: at the table the HUD leaves them blank.',
        seconds: 4.5,
      },
      {
        shot: 'app-hud-dropped',
        focus: 'designPicker',
        highlight: ['designPicker', 'save'],
        fill: 0.6,
        caption: 'A preset is never changed: the first edit makes your own copy, unsaved until you press Save.',
        seconds: 4.5,
      },
      {
        shot: 'app-hud-cell-settings',
        focus: 'cellSettings',
        highlight: ['decimals', 'minSample'],
        caption: 'A click on a cell opens its settings beside it: decimals, and from how many hands it takes full colour.',
        seconds: 4.5,
      },
      {
        shot: 'app-hud-cell-settings',
        focus: 'cellSettings',
        highlight: ['bands', 'tryValue'],
        caption: 'Its colour limits: suggested, for a tighter or a looser game, or your own. Try a value to see the colour it gets.',
        seconds: 5,
      },
      {
        shot: 'app-hud-cell-stack',
        focus: 'cellSettings',
        highlight: ['stack', 'stackHint'],
        caption: 'A cell can show only at some stack depths. PokerStars and Winamax do not allow that; ACR does.',
        seconds: 4.5,
      },
    ],
  },
  {
    title: 'Preview and tables',
    steps: [
      {
        shot: 'app-hud-preview',
        focus: 'previewCard',
        highlight: 'previewTable',
        caption: 'The preview draws the design at a table of the room and size picked, with made-up players and numbers.',
        seconds: 4.5,
      },
      {
        shot: 'app-hud-preview',
        focus: 'previewCard',
        highlight: 'previewVerdict',
        caption: 'Under it, the room’s verdict: the design may be used at PokerStars, without your colour tags, labels and notes.',
        seconds: 4.5,
      },
      {
        shot: 'app-hud-preview-winamax',
        focus: 'previewCard',
        highlight: ['previewRoom', 'previewSeats'],
        caption: 'Another room or table size redraws it: here a 9-max Winamax table.',
        seconds: 4,
      },
      {
        shot: 'app-hud-preview-winamax',
        focus: 'previewTable',
        cursor: 'previewPanel',
        highlight: 'previewPanel',
        caption: 'Drag a panel to where you want it: the HUD puts it there at every table of that room and size.',
        seconds: 4.5,
      },
      {
        shot: 'app-hud-popup-editor',
        focus: 'popupCard',
        highlight: 'firstSection',
        caption: 'The popup, drawn as at the table: what a click on a player’s panel shows, in sections with their own titles and statistics.',
        seconds: 4.5,
      },
      {
        shot: 'app-hud-saved',
        focus: 'designBar',
        highlight: 'designPicker',
        fill: 0.8,
        caption: 'Saved. A copy of a game’s preset takes the preset’s place at that game’s tables.',
        seconds: 4,
      },
      {
        shot: 'app-hud-assigned',
        focus: 'cashCard',
        highlight: ['cashPanel', 'cashDesign'],
        fill: 0.5,
        caption: 'At the tables, cash tables now get your copy, its panel drawn small.',
        seconds: 4,
      },
      {
        shot: 'app-hud-rules',
        focus: 'rulesPopover',
        highlight: ['rule', 'cashRules'],
        fill: 0.6,
        caption: 'A rule sends some tables elsewhere: here Winamax cash tables keep the preset. The most specific rule wins.',
        seconds: 5,
      },
    ],
  },
  {
    title: 'The popup',
    steps: [
      {
        shot: 'app-popup',
        focus: 'header',
        highlight: ['facts', 'ownHands'],
        caption: 'Click a player’s panel at the table: the popup shows their numbers. At Winamax, from hands you played only.',
        seconds: 5,
      },
      {
        shot: 'app-popup',
        focus: 'words',
        highlight: 'words',
        caption: 'Winamax allows labelling players, so your colour tag, labels and note are here too.',
        seconds: 4,
      },
      {
        shot: 'app-popup-stats',
        highlight: 'firstTable',
        caption: 'The design’s sections, coloured as on the panel. A value fades while its sample is thin.',
        seconds: 4,
      },
      {
        shot: 'app-popup-foot',
        highlight: ['byPosition', 'openInApp'],
        caption: 'No rows by position at Winamax tables. Open in Rail shows the player’s profile. Past hands only, no advice.',
        seconds: 5,
      },
    ],
  },
];
