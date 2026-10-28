// analysis-session: reviewing a session. Shots: capture/web/analysis-session.ts.

import type { Tutorial } from './types.ts';

export const script: Tutorial = {
  slug: 'analysis-session',
  title: 'Session review',
  subtitle: 'After a session, the hands worth a second look',
  where: 'Analysis → Session review · /analysis/session',
  next: 'analysis-leaks',
  chapters: [
    {
      title: 'The session',
      steps: [
        {
          shot: 'review',
          focus: 'picker',
          fill: 0.75,
          highlight: ['picker', 'previous'],
          caption: 'Session review opens on your latest finished session. A break longer than 30 minutes ends a session.',
          seconds: 6,
        },
        {
          shot: 'review',
          focus: 'summary',
          fill: 0.85,
          highlight: 'summary',
          caption: 'The summary: when, hands, length, tables, result in money and big blinds, bb/100 and all-in EV.',
          seconds: 6,
        },
      ],
    },
    {
      title: 'Worth a look',
      steps: [
        {
          shot: 'review',
          focus: 'worst',
          fill: 0.8,
          highlight: 'worst',
          caption: 'Worst decisions: graded Inaccurate or worse, the worst first, with the EV each cost.',
          seconds: 6,
        },
        {
          shot: 'review',
          focus: 'charts',
          fill: 0.8,
          highlight: 'charts',
          caption: 'Off your preflop charts: decisions the charts take rarely or never.',
          seconds: 5.5,
        },
        {
          shot: 'review',
          focus: 'pots',
          fill: 0.8,
          highlight: 'pots',
          caption: 'Biggest pots, in big blinds. A hand appears once, in the first list it is in; badges point to the others.',
          seconds: 6,
        },
        {
          shot: 'review',
          focus: 'firstWorst',
          fill: 0.7,
          cursor: 'firstWorst',
          click: true,
          highlight: 'firstWorst',
          caption: 'Choose a hand to open it at that decision.',
          seconds: 4.5,
        },
        {
          shot: 'decision',
          focus: 'sheet',
          fill: 0.5,
          highlight: ['sheet', 'back'],
          caption: 'Its analysis opens, with a way back to the review.',
          seconds: 5,
        },
      ],
    },
  ],
};
