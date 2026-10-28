// library: the hand history list, filters, searches, order, a hand opened
// beside the list. Shots: capture/web/library.ts.

import type { Tutorial } from './types.ts';

export const script: Tutorial = {
  slug: 'library',
  title: 'Your hand library',
  subtitle: 'Find any hand you have played with filters, searches and the order you want',
  where: 'Hand history · /library',
  next: 'replayer',
  chapters: [
    {
      title: 'The list',
      steps: [
        {
          shot: 'list',
          cursor: 'tab',
          click: true,
          highlight: 'heading',
          caption: 'Hand history lists every hand in your library, newest first.',
          seconds: 4,
        },
        {
          shot: 'list',
          focus: 'firstRow',
          fill: 0.75,
          highlight: 'firstRow',
          caption: 'Each row: when, the room and hand number, stakes, your position, your cards, the board and your result.',
          seconds: 5,
        },
      ],
    },
    {
      title: 'Filters',
      steps: [
        {
          shot: 'list',
          focus: 'filters',
          fill: 0.85,
          highlight: 'filters',
          caption: 'Filters are chips in one row: date, room, stakes, position, pot, result, stack depth and more.',
          seconds: 4.5,
        },
        {
          shot: 'date',
          focus: 'popover',
          fill: 0.45,
          cursor: 'chip',
          click: true,
          highlight: 'popover',
          caption: 'A chip opens its options, each with the number of hands it would match.',
          seconds: 4.5,
        },
        {
          shot: 'position',
          focus: 'popover',
          fill: 0.45,
          cursor: 'chip',
          click: true,
          highlight: 'popover',
          caption: 'Filters add up: here the last 30 days, then the button.',
          seconds: 4,
        },
        {
          shot: 'filtered',
          focus: 'filters',
          fill: 0.85,
          highlight: ['date', 'position', 'count'],
          caption: 'The set chips show their value, and the count shows how many hands are left. Clear all starts over.',
          seconds: 5,
        },
      ],
    },
    {
      title: 'Search and order',
      steps: [
        {
          shot: 'search',
          focus: 'popover',
          fill: 0.45,
          cursor: 'cards',
          highlight: 'popover',
          caption: 'Search finds hands by your cards or a hand class, cards on the board, a player, a table or a minimum pot.',
          seconds: 5,
        },
        {
          shot: 'order',
          focus: 'popover',
          fill: 0.4,
          cursor: 'chip',
          click: true,
          highlight: 'popover',
          caption: 'Order sorts by date, the biggest pots, or your biggest wins or losses.',
          seconds: 4,
        },
        {
          shot: 'searched',
          focus: 'list',
          fill: 0.8,
          highlight: 'firstRow',
          cursor: 'firstRow',
          click: true,
          caption: 'Here: every hand with ace-king, biggest pots first.',
          seconds: 4,
        },
        {
          shot: 'open',
          highlight: 'replayer',
          caption: 'Choose a hand and it opens in the replayer beside the list; the arrow keys move through the list.',
          seconds: 5,
        },
        {
          shot: 'open',
          focus: 'share',
          fill: 0.35,
          highlight: ['share', 'publish', 'close'],
          caption: 'From here you can share the hand as a link, publish it to the forum, or close the replayer.',
          seconds: 4.5,
        },
      ],
    },
  ],
};
