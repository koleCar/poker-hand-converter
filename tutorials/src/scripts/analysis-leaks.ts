// analysis-leaks: the leak report, the weekly plan and progress. Shots:
// capture/web/analysis-leaks.ts.

import type { Tutorial } from './types.ts';

export const script: Tutorial = {
  slug: 'analysis-leaks',
  title: 'Leaks, plan and progress',
  subtitle: 'Where you lose the most EV, what to work on this week, and whether it is getting better',
  where: 'Analysis → Leaks, Plan, Progress',
  next: 'analysis-charts',
  chapters: [
    {
      title: 'Leaks',
      steps: [
        {
          shot: 'report',
          focus: 'heading',
          fill: 0.9,
          maxZoom: 1,
          highlight: 'filters',
          caption: 'Leaks groups your graded decisions by street, spot and seat, the costliest first. Filter by dates, room, stakes and position.',
          seconds: 7.5,
        },
        {
          shot: 'report',
          focus: 'first',
          fill: 0.8,
          cursor: 'first',
          click: true,
          highlight: 'first',
          caption: 'Each leak: what you did, the EV it cost per 100 hands, mistakes in the spot, and how confident the sample is.',
          seconds: 7,
        },
        {
          shot: 'leak',
          focus: 'item',
          fill: 0.85,
          highlight: 'item',
          caption: 'Opened: what you did against what the reference does with your hands, and the numbers behind it.',
          seconds: 7,
        },
        {
          shot: 'leak',
          focus: 'hands',
          fill: 0.7,
          highlight: ['drill', 'hands'],
          caption: 'Drill this practises the spot; your hands in it open at the decision.',
          seconds: 6,
        },
      ],
    },
    {
      title: 'Plan and progress',
      steps: [
        {
          shot: 'plan',
          focus: 'heading',
          fill: 0.75,
          highlight: ['progress', 'focus'],
          caption: 'Plan builds a week’s work from your leaks: focus areas with tasks to tick off.',
          seconds: 6.5,
        },
        {
          shot: 'progress',
          focus: 'score',
          fill: 0.85,
          highlight: ['groupBy', 'score'],
          caption: 'Progress shows your score and the EV you lose over time, by week, month or session.',
          seconds: 6.5,
        },
      ],
    },
  ],
};
