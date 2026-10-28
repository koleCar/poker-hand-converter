// analysis-charts: Rail's preflop charts, your own, and the trainer.
// Shots: capture/web/analysis-charts.ts.

import type { Tutorial } from './types.ts';

export const script: Tutorial = {
  slug: 'analysis-charts',
  title: 'Charts and training',
  subtitle: 'Rail’s preflop charts, charts of your own, and practising against them',
  where: 'Analysis → Charts, Your charts, Train',
  next: 'learn',
  chapters: [
    {
      title: 'Rail’s charts',
      steps: [
        {
          shot: 'charts',
          focus: 'grid',
          fill: 0.7,
          highlight: ['table', 'scenario', 'spot'],
          caption: 'The charts the analysis grades by: choose the table and depth, the scenario and the spot.',
          seconds: 6,
        },
        {
          shot: 'charts',
          focus: 'grid',
          fill: 0.7,
          cursor: 'cell',
          highlight: ['grid', 'legend'],
          caption: 'Every hand’s mix of actions, in the colours of the legend. Point at a hand for its numbers.',
          seconds: 6,
        },
      ],
    },
    {
      title: 'Your charts',
      steps: [
        {
          shot: 'my-charts',
          focus: 'grid',
          fill: 0.75,
          highlight: ['brush', 'grid'],
          caption: 'Build your own charts situation by situation: choose a mix and paint it on the grid.',
          seconds: 6,
        },
        {
          shot: 'my-charts',
          focus: 'fromRail',
          fill: 0.6,
          highlight: ['fromRail', 'save'],
          caption: 'Start from Rail’s chart, paste ranges or copy them out, then save. Compare with your hands shows where you differ.',
          seconds: 6.5,
        },
      ],
    },
    {
      title: 'Training',
      steps: [
        {
          shot: 'train',
          focus: 'options',
          fill: 0.75,
          highlight: ['what', 'options'],
          caption: 'Train deals spots: preflop, river, or your own mistakes. Answer with a click or a key.',
          seconds: 6,
        },
        {
          shot: 'train-answer',
          focus: 'options',
          fill: 0.8,
          highlight: 'options',
          caption: 'Each answer is graded exactly as the analysis would grade it, with every option’s EV and the reason.',
          seconds: 6.5,
        },
        {
          shot: 'train-answer',
          focus: 'next',
          fill: 0.3,
          maxZoom: 1,
          cursor: 'next',
          click: true,
          highlight: 'next',
          caption: 'Then on to the next spot.',
          seconds: 4,
        },
      ],
    },
  ],
};
