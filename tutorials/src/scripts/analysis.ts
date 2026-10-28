// analysis: the overview and one hand's analysis. The other parts are
// analysis-session, analysis-leaks and analysis-charts. Shots:
// capture/web/analysis.ts.

import type { Tutorial } from './types.ts';

export const script: Tutorial = {
  slug: 'analysis',
  title: 'Analysis',
  subtitle: 'Every decision in your library, graded against Rail’s charts and solver',
  where: 'Analysis · /analysis',
  next: 'analysis-session',
  chapters: [
    {
      title: 'Your analysis',
      steps: [
        {
          shot: 'top',
          cursor: 'tab',
          click: true,
          highlight: 'subnav',
          caption: 'Analysis has its own sections: your analysis, session review, plan, training, leaks, progress, reports and charts.',
          seconds: 5,
        },
        {
          shot: 'page',
          focus: 'grades',
          fill: 0.85,
          highlight: 'grades',
          caption: 'Preflop is graded against Rail’s charts, the turn and river against its solver: Perfect, Good, Inaccurate, Mistake or Blunder.',
          seconds: 6,
        },
        {
          shot: 'page',
          focus: 'grades',
          fill: 0.85,
          highlight: 'street',
          caption: 'The score, the EV you lost per 100 hands, and how the grades split by street.',
          seconds: 4.5,
        },
        {
          shot: 'page',
          focus: 'coverage',
          fill: 0.9,
          highlight: ['coverage', 'flags'],
          caption: 'Coverage says what could be graded; flags are notes on facts that hold whatever the strategy, never grades.',
          seconds: 5,
        },
        {
          shot: 'page',
          focus: 'firstLeak',
          fill: 0.8,
          highlight: 'leaks',
          caption: 'Your three biggest leaks, the most EV lost first, with example hands.',
          seconds: 5,
        },
        {
          shot: 'page',
          focus: 'hands',
          fill: 0.85,
          highlight: 'firstHand',
          cursor: 'firstHand',
          click: true,
          caption: 'Every analysed hand, filterable by street, flag and grade. Open one to see its analysis.',
          seconds: 4.5,
        },
      ],
    },
    {
      title: 'One hand',
      steps: [
        {
          shot: 'hand',
          focus: 'sheet',
          fill: 0.5,
          highlight: 'sheet',
          caption: 'The hand opens in the replayer with the Analysis sheet: the grade, the EV lost, and the score.',
          seconds: 5,
        },
        {
          shot: 'hand',
          focus: 'replayer',
          fill: 0.95,
          highlight: 'decisions',
          caption: 'It notes what is approximate, and takes you to each of your decisions in turn.',
          seconds: 4.5,
        },
      ],
    },
  ],
};
