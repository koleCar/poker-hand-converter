// The desktop app in daily use: Today's session, Hands (filter chips with
// their counts, saved filters, the replayer beside the list, tags and a
// note), Reports (one room's money, statistics, breakdowns, the starting-hand
// grid), Players (a profile, colour tag, label, note, hands with them),
// Analysis (session review, top leaks), the command palette and the
// preferences. Shots: `capture/desktop/capture.ts` (`captureDesktopApp`).
// Captions say what the app's code and its English strings
// (`app/src/i18n/en.ts`, `packages/ui/strings/*.en.ts`) do.

import type { Tutorial } from './types.ts';

export const script: Tutorial = {
  slug: 'desktop-app',
  title: 'The desktop app, day to day',
  subtitle: 'Your session, your hands, reports, players and the analysis, on this computer',
  where: 'Rail desktop app · Today, Hands, Reports, Players, Analysis',
  next: 'hud',
  chapters: [
    {
      title: 'Today',
      steps: [
        {
          shot: 'today-session',
          focus: 'sessionTiles',
          highlight: 'sessionTiles',
          caption: 'Today opens on the current session: result in money and big blinds, hands, hands per hour and tables.',
          seconds: 4.5,
        },
        {
          shot: 'today-session',
          focus: 'keyStats',
          highlight: 'keyStats',
          fill: 0.55,
          caption: 'Its key statistics, each with its sample. A break longer than 30 minutes starts a new session.',
          seconds: 4,
        },
        {
          shot: 'today-pots',
          focus: 'potsTable',
          highlight: 'firstPot',
          caption: 'The session’s biggest pots, in big blinds; each opens in Hands.',
          seconds: 3.5,
        },
      ],
    },
    {
      title: 'Hands',
      steps: [
        {
          shot: 'hands-chip',
          focus: 'popover',
          highlight: 'popover',
          fill: 0.5,
          caption: 'Hands lists every hand on this computer. Each filter chip shows how many hands every choice holds.',
          seconds: 4.5,
        },
        {
          shot: 'hands-saved',
          focus: 'savedPopover',
          cursor: 'savedItem',
          click: true,
          highlight: 'savedItem',
          fill: 0.4,
          caption: 'Saved filters bring back a set of chips with one click.',
          seconds: 3.5,
        },
        {
          shot: 'hands-filtered',
          focus: 'filters',
          highlight: ['positionChip', 'potChip', 'count'],
          caption: '3-bet pots on the button: the chips say what is set, the count how many of your hands match.',
          seconds: 4.5,
        },
        {
          shot: 'hands-replayer',
          focus: 'replayer',
          highlight: 'replayer',
          caption: 'A hand opens in the replayer beside the list, street by street.',
          seconds: 3.5,
        },
        {
          shot: 'hands-replayer',
          focus: 'tags',
          highlight: ['newTag', 'note'],
          fill: 0.5,
          caption: 'Tag it and write a note. Tags and notes stay on this computer for now.',
          seconds: 3.5,
        },
      ],
    },
    {
      title: 'Reports',
      steps: [
        {
          shot: 'reports-summary',
          focus: 'summary',
          highlight: ['roomChip', 'summary'],
          caption: 'Reports adds up the hands the filter keeps. Here PokerStars only: one currency, so the result shows in money too.',
          seconds: 5,
        },
        {
          shot: 'reports-money',
          focus: 'graph',
          cursor: 'money',
          click: true,
          highlight: 'graph',
          caption: 'Winnings over time, in big blinds or money: the total, showdown and non-showdown lines, and the all-in EV line.',
          seconds: 5,
        },
        {
          shot: 'reports-stats',
          focus: 'stats',
          highlight: 'stats',
          caption: 'Every statistic with its sample. A value fades while its sample is thin.',
          seconds: 4,
        },
        {
          shot: 'reports-grid',
          focus: 'matrix',
          highlight: ['startingHands', 'aks'],
          fill: 0.75,
          caption: 'Breakdowns split the hands by position, pot, stakes and more. Starting hands is a 13 x 13 grid; a cell lists its numbers.',
          seconds: 5.5,
        },
      ],
    },
    {
      title: 'Players',
      steps: [
        {
          shot: 'players-list',
          focus: 'playerList',
          highlight: 'search',
          caption: 'Players lists your opponents, most hands together first, with your result against each.',
          seconds: 4,
        },
        {
          shot: 'players-profile',
          focus: 'words',
          highlight: ['colourTag', 'labels', 'note'],
          caption: 'A profile takes a colour tag, labels and a note, kept on this computer; the HUD can show them where the room allows it.',
          seconds: 5,
        },
        {
          shot: 'players-hands',
          focus: 'filters',
          highlight: ['playerChip', 'count'],
          caption: 'Hands with this player opens Hands filtered to the hands you played with them.',
          seconds: 3.5,
        },
      ],
    },
    {
      title: 'Analysis',
      steps: [
        {
          shot: 'analysis-session',
          focus: 'status',
          highlight: 'status',
          fill: 0.5,
          caption: 'Analysis grades your decisions in the background, on this computer: here every hand is analysed.',
          seconds: 4,
        },
        {
          shot: 'analysis-session',
          highlight: ['ongoing', 'sessionSummary'],
          caption: 'The session review shows the latest finished session: the current one may still be going on, and the review is for after you play.',
          seconds: 5,
        },
        {
          shot: 'analysis-worst',
          focus: 'worst',
          highlight: 'firstWorst',
          caption: 'Your worst graded decisions, with the EV each cost and the best move; below them, where you left your preflop charts.',
          seconds: 5,
        },
        {
          shot: 'analysis-leaks',
          focus: 'firstLeak',
          highlight: 'firstLeak',
          caption: 'Top leaks: the three spots that cost you most over the last 30 days, how sure the sample is, and the 30 days before.',
          seconds: 5,
        },
      ],
    },
    {
      title: 'Palette and preferences',
      steps: [
        {
          shot: 'palette-player',
          focus: 'paletteList',
          highlight: 'playerOption',
          fill: 0.5,
          caption: 'Cmd or Ctrl + K: the start of a player’s name finds them…',
          seconds: 3.5,
        },
        {
          shot: 'palette-hand',
          focus: 'paletteList',
          highlight: 'handOption',
          fill: 0.5,
          caption: '…a hand’s number as the room printed it finds the hand.',
          seconds: 3,
        },
        {
          shot: 'palette-fuzzy',
          focus: 'paletteList',
          highlight: 'shortcutHint',
          fill: 0.5,
          caption: 'A few letters find screens and reports; each screen shows its shortcut, Cmd or Ctrl + 1 to 7.',
          seconds: 4,
        },
        {
          shot: 'palette-command',
          focus: 'paletteList',
          cursor: 'compact',
          click: true,
          highlight: 'compact',
          fill: 0.5,
          caption: 'It runs commands too: compact lists and tables…',
          seconds: 3,
        },
        {
          shot: 'prefs-light',
          highlight: 'handList',
          caption: '…the light theme…',
          seconds: 2.5,
        },
        {
          shot: 'prefs-croatian',
          highlight: ['sidebar', 'session'],
          caption: '…or Croatian, with numbers and dates in it. All three are in Settings too.',
          seconds: 3.5,
        },
      ],
    },
  ],
};
