// community: the forum. Shots: capture/web/community.ts.

import type { Tutorial } from './types.ts';

export const script: Tutorial = {
  slug: 'community',
  title: 'The community',
  subtitle: 'Publish a hand, ask about it, and discuss it street by street',
  where: 'Forum · /, /f, /submit, /notifications, /u',
  next: 'account',
  chapters: [
    {
      title: 'The forum',
      steps: [
        {
          shot: 'feed',
          cursor: 'forum',
          highlight: 'boards',
          caption: 'The forum has four boards: No-Limit Hold’em, Tournaments, Omaha and General.',
          seconds: 4.5,
        },
        {
          shot: 'feed',
          focus: 'first',
          fill: 0.8,
          highlight: ['first', 'sort'],
          caption: 'Posts sort by Hot, New or Top. Votes rank them; a hand post carries a Hand badge.',
          seconds: 5,
        },
      ],
    },
    {
      title: 'A hand thread',
      steps: [
        {
          shot: 'thread',
          focus: 'title',
          fill: 0.6,
          highlight: 'controls',
          caption: 'A thread about a hand: save it, follow it for notifications, or mute it.',
          seconds: 4.5,
        },
        {
          shot: 'thread',
          focus: 'replay',
          fill: 0.8,
          highlight: 'replay',
          caption: 'The hand is in the thread, in the replayer, with the players’ names replaced by Hero and Villain.',
          seconds: 5,
        },
        {
          shot: 'comment',
          focus: 'composer',
          fill: 0.75,
          highlight: ['attached', 'composer'],
          caption: 'Comment on this spot ties your comment to the moment the replayer is at; readers can jump there.',
          seconds: 5,
        },
        {
          shot: 'thread',
          focus: 'comments',
          fill: 0.75,
          highlight: 'comments',
          caption: 'Replies nest under the comment they answer, and sort by Best, New or Top.',
          seconds: 4.5,
        },
      ],
    },
    {
      title: 'Posting a hand',
      steps: [
        {
          shot: 'publish',
          focus: 'dialog',
          fill: 0.55,
          cursor: 'trigger',
          click: true,
          highlight: ['names', 'publish'],
          caption: 'Publish hand, from your library, makes a public copy. Names become Villain1, Villain2… unless you choose otherwise.',
          seconds: 6,
        },
        {
          shot: 'submit',
          focus: 'title',
          fill: 0.6,
          highlight: ['board', 'title', 'hand'],
          caption: 'Then start a thread about it: pick a board and a title; the hand is attached.',
          seconds: 4.5,
        },
        {
          shot: 'submit',
          focus: 'poll',
          fill: 0.5,
          highlight: 'poll',
          caption: 'Or make it a poll: readers see the hand stop at your decision and say what they would do first.',
          seconds: 5,
        },
      ],
    },
    {
      title: 'Staying in touch',
      steps: [
        {
          shot: 'notifications',
          focus: 'list',
          fill: 0.75,
          cursor: 'bell',
          highlight: ['list', 'bell'],
          caption: 'The bell counts replies and mentions. Notifications lists them; open one to go to the comment.',
          seconds: 5,
        },
        {
          shot: 'profile',
          focus: 'name',
          fill: 0.4,
          highlight: 'hands',
          caption: 'Your profile shows your name, when you joined, your karma and the hands you published.',
          seconds: 4.5,
        },
      ],
    },
  ],
};
