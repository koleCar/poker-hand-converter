// replayer: stepping through a hand, pot odds, the result, settings, the
// action log, a share link and the shared page. Shots: capture/web/replayer.ts.

import type { Tutorial } from './types.ts';

export const script: Tutorial = {
  slug: 'replayer',
  title: 'The replayer',
  subtitle: 'Step through a hand street by street, then share it with a link',
  where: 'any hand · Hand history, the converter, shared links',
  next: 'stats',
  chapters: [
    {
      title: 'Playing a hand',
      steps: [
        {
          shot: 'start',
          focus: 'replayer',
          fill: 0.9,
          highlight: 'hero',
          caption: 'The replayer draws the table as the hand began: seats, positions, stacks, and your cards.',
          seconds: 4.5,
        },
        {
          shot: 'start',
          focus: 'transport',
          fill: 0.85,
          cursor: 'play',
          highlight: ['play', 'next'],
          caption: 'Play runs the hand; the arrows step one action back or forward. The arrow keys and space do the same.',
          seconds: 5,
        },
        {
          shot: 'flop',
          focus: 'replayer',
          fill: 0.9,
          cursor: 'flop',
          click: true,
          highlight: 'flop',
          caption: 'Jump straight to a street. The pot and every bet in front of a seat follow the action.',
          seconds: 4.5,
        },
        {
          shot: 'odds',
          focus: 'odds',
          fill: 0.35,
          highlight: 'odds',
          callout: 'Pot odds',
          caption: 'When you face a bet, pot odds show what the call costs, what it wins, and the equity it needs.',
          seconds: 5,
        },
        {
          shot: 'result',
          focus: 'sheet',
          fill: 0.75,
          highlight: 'sheet',
          caption: 'At the end the result sheet shows the cards shown, each hand made, and who won what.',
          seconds: 5,
        },
      ],
    },
    {
      title: 'Your view',
      steps: [
        {
          shot: 'settings',
          focus: 'sheet',
          fill: 0.6,
          highlight: ['known', 'bb', 'odds'],
          caption: 'Settings: chips in big blinds, every known card shown from the start, pot odds on or off.',
          seconds: 5,
        },
        {
          shot: 'log',
          focus: 'log',
          fill: 0.6,
          highlight: 'log',
          caption: 'The action log lists every action; choose one to jump there.',
          seconds: 4,
        },
      ],
    },
    {
      title: 'Sharing',
      steps: [
        {
          shot: 'share',
          focus: 'panel',
          fill: 0.5,
          cursor: 'trigger',
          click: true,
          highlight: ['url', 'copy'],
          caption: 'Share makes a link and copies it. Anyone with the link can replay the hand, no account needed.',
          seconds: 5,
        },
        {
          shot: 'share',
          focus: 'panel',
          fill: 0.5,
          highlight: 'names',
          caption: "The players' names are hidden on a link unless you turn them on for it.",
          seconds: 4,
        },
        {
          shot: 'shared-page',
          focus: 'replay',
          fill: 0.85,
          highlight: 'seats',
          caption: 'This is what the link opens: the same replayer, with Hero and Villain in place of the names.',
          seconds: 5,
        },
      ],
    },
  ],
};
