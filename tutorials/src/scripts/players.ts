// players: opponent profiles. Shots: capture/web/players.ts.

import type { Tutorial } from './types.ts';

export const script: Tutorial = {
  slug: 'players',
  title: 'Players',
  subtitle: 'The opponents in your hands: their statistics, your result against them, your notes',
  where: 'Statistics → Players · /players',
  next: 'analysis',
  chapters: [
    {
      title: 'Turning it on',
      steps: [
        {
          shot: 'off',
          focus: 'explain',
          fill: 0.6,
          cursor: 'turnOn',
          click: true,
          highlight: 'turnOn',
          caption: 'Opponent statistics are off until you turn them on. Rail then reads your opponents from your hands.',
          seconds: 5.5,
        },
      ],
    },
    {
      title: 'Your opponents',
      steps: [
        {
          shot: 'list',
          focus: 'list',
          fill: 0.8,
          highlight: 'header',
          caption: 'The players you met most come first, with your hands together and your result against them.',
          seconds: 5.5,
        },
        {
          shot: 'search',
          focus: 'search',
          fill: 0.45,
          highlight: 'search',
          caption: 'Search by the start of a name, or narrow the list by game, room or players you noted.',
          seconds: 5,
        },
      ],
    },
    {
      title: 'A profile',
      steps: [
        {
          shot: 'profile',
          focus: 'facts',
          fill: 0.75,
          highlight: ['facts', 'result'],
          caption: 'A profile: hands together, first and last seen, and your result against them.',
          seconds: 5.5,
        },
        {
          shot: 'profile',
          focus: 'stats',
          fill: 0.7,
          highlight: 'stats',
          caption: 'Their statistics over every hand of theirs Rail has seen, and a breakdown by position, stakes, table size and game.',
          seconds: 5.5,
        },
        {
          shot: 'note',
          focus: 'note',
          fill: 0.6,
          highlight: 'note',
          caption: 'Your note on the player is private to your account and saves as you type.',
          seconds: 5,
        },
        {
          shot: 'note',
          focus: 'hands',
          fill: 0.45,
          cursor: 'hands',
          click: true,
          highlight: 'hands',
          caption: 'Hands with this player opens your hand history filtered to them.',
          seconds: 4.5,
        },
        {
          shot: 'hands',
          focus: 'filters',
          fill: 0.8,
          highlight: ['player', 'list'],
          caption: 'Every hand you played together, ready to replay.',
          seconds: 4.5,
        },
      ],
    },
  ],
};
