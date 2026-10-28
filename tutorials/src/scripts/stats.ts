// stats: the statistics page. Shots: capture/web/stats.ts.

import type { Tutorial } from './types.ts';

export const script: Tutorial = {
  slug: 'stats',
  title: 'Your statistics',
  subtitle: 'Win rate, every statistic with how far to trust it, and where you win and lose',
  where: 'Statistics · /stats',
  next: 'players',
  chapters: [
    {
      title: 'The summary',
      steps: [
        {
          shot: 'top',
          focus: 'summary',
          fill: 0.8,
          highlight: 'summary',
          caption: 'Statistics starts with the totals: hands, result, big blinds, bb/100 and all-in EV bb/100.',
          seconds: 5,
        },
        {
          shot: 'top',
          focus: 'filters',
          fill: 0.8,
          highlight: 'filters',
          caption: 'The same filter chips as the library. With cash and tournaments mixed, it shows cash only until you change Game.',
          seconds: 5,
        },
        {
          shot: 'top',
          focus: 'hud',
          fill: 0.8,
          highlight: 'hud',
          caption: 'Each statistic shows its value, the hands it counts, and a ± range: a thin sample is shown fainter.',
          seconds: 5,
        },
      ],
    },
    {
      title: 'Winnings',
      steps: [
        {
          shot: 'graph',
          focus: 'graph',
          fill: 0.85,
          highlight: 'chart',
          caption: 'The win-rate graph: your total, showdown and non-showdown winnings, and all-in EV, over your hands.',
          seconds: 5,
        },
        {
          shot: 'graph-money',
          focus: 'graph',
          fill: 0.85,
          cursor: 'money',
          click: true,
          highlight: 'money',
          caption: 'Show it in big blinds or in money.',
          seconds: 3.5,
        },
        {
          shot: 'statistics',
          focus: 'tables',
          fill: 0.8,
          highlight: 'tables',
          caption: 'Every statistic by group, results, preflop, postflop and showdown, each with its sample.',
          seconds: 4.5,
        },
      ],
    },
    {
      title: 'Breakdowns',
      steps: [
        {
          shot: 'breakdown',
          focus: 'card',
          fill: 0.8,
          highlight: 'tabs',
          caption: 'The breakdown splits your results by position, pot type, stack depth, stakes, table size, room and more.',
          seconds: 5,
        },
        {
          shot: 'grid',
          focus: 'grid',
          fill: 0.75,
          highlight: 'colourBy',
          caption: 'Starting hands: all 169 in a 13 × 13 grid, coloured by win rate, VPIP, PFR or how often dealt.',
          seconds: 5,
        },
        {
          shot: 'grid-cell',
          focus: 'detail',
          fill: 0.8,
          cursor: 'aks',
          click: true,
          highlight: ['aks', 'detail'],
          caption: 'Choose a hand for its numbers in this sample.',
          seconds: 4,
        },
        {
          shot: 'sessions',
          focus: 'card',
          fill: 0.8,
          highlight: ['bankroll', 'breakSelect'],
          caption: 'Sessions: your hands grouped by a break you choose, with the bankroll over them and a review of each.',
          seconds: 5,
        },
      ],
    },
  ],
};
