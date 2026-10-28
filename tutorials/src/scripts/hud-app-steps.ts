// Draft: the desktop app's part of the `hud` tutorial - the HUD screen (the
// tables with and without the HUD, and why), the macOS Accessibility card,
// the editor (presets, a copy, a statistic dragged onto the panel, its
// settings, the preview per room, the popup's sections, which design each
// table gets) and the HUD popup window. Shots `app-...` from
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
        focus: 'attachedList',
        highlight: 'attachedList',
        fill: 0.5,
        caption: 'The HUD screen lists the tables the HUD is on. A table with no hand yet says it is waiting for its first hand.',
        seconds: 4.5,
      },
      {
        shot: 'app-hud-tables',
        focus: 'refusedList',
        highlight: 'refusedRow',
        callout: 'Prohibited',
        caption: 'A GGPoker table gets no HUD: GGPoker’s rules do not allow one. The room’s policy page and the date it was checked are linked.',
        seconds: 5,
      },
      {
        shot: 'app-hud-tables',
        focus: 'refusedList',
        highlight: ['unknownRow', 'noOverride'],
        caption: 'Where a room’s rules are not established, as at WePlay, unknown counts as no. There is no switch to override it.',
        seconds: 5,
      },
      {
        shot: 'app-hud-rooms',
        focus: 'rooms',
        highlight: 'allowedRooms',
        caption: 'Allowed today: PokerStars, Winamax and ACR, each within its own rules. An update of the room list can only make it stricter.',
        seconds: 5,
      },
      {
        shot: 'app-hud-permission',
        focus: 'permissionCard',
        highlight: ['permissionWhy', 'permissionNot'],
        caption: 'On a Mac the HUD reads table windows’ titles, which needs the Accessibility permission. Rail asks only when it would find tables.',
        seconds: 5,
      },
      {
        shot: 'app-hud-permission',
        focus: 'permissionCard',
        cursor: 'permissionButton',
        click: true,
        highlight: 'permissionButton',
        caption: 'Open System Settings shows macOS’s own prompt; switch Rail on there and this screen notices by itself.',
        seconds: 4.5,
      },
    ],
  },
  {
    title: 'Designs',
    steps: [
      {
        shot: 'app-hud-presets',
        focus: 'designsCard',
        highlight: ['designPicker', 'presetDescription'],
        caption: 'Three presets: Cash, Tournament and Spin. A preset cannot be changed.',
        seconds: 4,
      },
      {
        shot: 'app-hud-preset-spin',
        focus: 'designsCard',
        highlight: 'presetDescription',
        caption: 'Spin is made for three-handed hyper-turbos, where almost every hand is a steal or a defence.',
        seconds: 4,
      },
      {
        shot: 'app-hud-presets',
        focus: 'designsCard',
        highlight: 'roomChecks',
        caption: 'Under each design: where it may be used. PokerStars and ACR leave out colour tags, labels and notes.',
        seconds: 4.5,
      },
      {
        shot: 'app-hud-presets',
        focus: 'makeCopy',
        cursor: 'makeCopy',
        click: true,
        highlight: 'makeCopy',
        fill: 0.4,
        caption: 'Make my copy starts a design of your own from the preset.',
        seconds: 3.5,
      },
      {
        shot: 'app-hud-copy',
        focus: 'designsCard',
        highlight: ['name', 'save', 'unsaved'],
        caption: 'The copy has a name and a game, and stays unsaved until you press Save.',
        seconds: 4,
      },
    ],
  },
  {
    title: 'The panel',
    steps: [
      {
        shot: 'app-hud-panel',
        focus: 'panelCard',
        highlight: ['statsPalette', 'panelCells'],
        caption: 'The panel: the statistics on the left, the panel’s cells in the middle.',
        seconds: 4,
      },
      {
        shot: 'app-hud-panel',
        focus: 'panelCells',
        cursor: 'stealChip',
        highlight: 'search',
        fill: 0.7,
        caption: 'Find a statistic narrows the list.',
        seconds: 3,
      },
      {
        shot: 'app-hud-panel',
        focus: 'panelCells',
        cursor: 'dropZone',
        click: true,
        highlight: 'dropZone',
        fill: 0.7,
        caption: 'Drag a statistic onto the panel, or press Add on it. Cells move by dragging, or with Alt and the arrow keys.',
        seconds: 4.5,
      },
      {
        shot: 'app-hud-dropped',
        focus: 'panelCells',
        highlight: 'newCell',
        callout: 'Steal',
        caption: 'Steal is the panel’s seventh cell, and its settings open beside it.',
        seconds: 3.5,
      },
      {
        shot: 'app-hud-cell-settings',
        focus: 'cellSettings',
        highlight: ['decimals', 'minSample'],
        caption: 'Per cell: decimals, and the sample from which the value shows in full colour.',
        seconds: 4,
      },
      {
        shot: 'app-hud-cell-settings',
        focus: 'cellSettings',
        highlight: 'bands',
        caption: 'Your own colour bands: values below each limit take its colour; the last band holds the rest.',
        seconds: 4.5,
      },
      {
        shot: 'app-hud-cell-settings',
        focus: 'stackDepth',
        highlight: 'stackDepth',
        fill: 0.5,
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
        highlight: 'previewPanel',
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
        shot: 'app-hud-popup-editor',
        focus: 'popupSections',
        highlight: 'firstSection',
        caption: 'The popup’s sections: what a click on a player’s panel shows, each with its own title and statistics.',
        seconds: 4.5,
      },
      {
        shot: 'app-hud-assignments',
        focus: 'assignMatrix',
        highlight: ['cashAtStars', 'assignedTag'],
        caption: 'Which design each table gets, by room, game and table size. Here PokerStars cash tables get your copy.',
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
