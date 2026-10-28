// learn: the course. Shots: capture/web/learn.ts.

import type { Tutorial } from './types.ts';

export const script: Tutorial = {
  slug: 'learn',
  title: 'Learn',
  subtitle: 'A course from preflop to the river, with checkpoints and practice graded by Rail',
  where: 'Learn · /learn',
  next: 'community',
  chapters: [
    {
      title: 'The course',
      steps: [
        {
          shot: 'map',
          focus: 'heading',
          fill: 0.9,
          maxZoom: 1,
          highlight: ['placement', 'review'],
          caption: 'Learn is a course in tracks: preflop, the flop, the turn, the river and exploits.',
          seconds: 5.5,
        },
        {
          shot: 'map',
          focus: 'firstLesson',
          fill: 0.6,
          cursor: 'firstLesson',
          click: true,
          highlight: 'firstLesson',
          caption: 'Each lesson card shows where you stand: not started, in progress, tested out or mastered.',
          seconds: 5.5,
        },
      ],
    },
    {
      title: 'A lesson',
      steps: [
        {
          shot: 'lesson',
          focus: 'title',
          fill: 0.8,
          highlight: 'goals',
          caption: 'A lesson opens with what it covers and what to read first.',
          seconds: 5.5,
        },
        {
          shot: 'checkpoint',
          focus: 'checkpoint',
          fill: 0.75,
          cursor: 'choice',
          click: true,
          highlight: 'checkpoint',
          caption: 'Checkpoints ask you to predict before reading on: pick an answer, then see why.',
          seconds: 6,
        },
        {
          shot: 'exercise',
          focus: 'question',
          fill: 0.6,
          highlight: 'exercise',
          caption: 'Practice deals spots at a table. Pass every exercise Rail can grade to master the lesson.',
          seconds: 6,
        },
      ],
    },
    {
      title: 'Placement and review',
      steps: [
        {
          shot: 'placement',
          focus: 'take',
          fill: 0.5,
          cursor: 'take',
          highlight: 'take',
          caption: 'Already know a track? The placement test can mark its lessons as tested out.',
          seconds: 5.5,
        },
        {
          shot: 'review',
          focus: 'daily',
          fill: 0.5,
          highlight: 'daily',
          caption: 'Items you miss come back as review cards, a few minutes a day.',
          seconds: 5.5,
        },
      ],
    },
  ],
};
