// convert: dropping files on the converter, the results, a preview, a
// pasted hand, manual entry. Shots: capture/web/convert.ts.

import type { Tutorial } from './types.ts';

export const script: Tutorial = {
  slug: 'convert',
  title: 'Converting hand histories',
  subtitle: 'Drop your files, see what Rail read, and save the hands to your library',
  where: 'Upload hand · /convert',
  next: 'library',
  chapters: [
    {
      title: 'Drop your files',
      steps: [
        {
          shot: 'empty',
          focus: 'privacy',
          fill: 0.8,
          highlight: 'privacy',
          caption: 'Conversion happens in your browser tab. Nothing leaves it unless you save to your library.',
          seconds: 4.5,
        },
        {
          shot: 'empty',
          focus: 'drop',
          fill: 0.7,
          cursor: 'chooseFiles',
          click: true,
          highlight: ['chooseFiles', 'chooseFolder'],
          caption: 'Drop files, a zip or a whole export folder here, or choose them. Conversion starts at once.',
          seconds: 5,
        },
        {
          shot: 'empty',
          focus: 'save',
          fill: 0.5,
          highlight: ['save', 'originals'],
          caption: 'Signed in, Save to my library stores the converted hands as they convert. Keeping the original files is a separate choice, off by default.',
          seconds: 5.5,
        },
      ],
    },
    {
      title: 'What Rail read',
      steps: [
        {
          shot: 'results',
          focus: 'heading',
          fill: 0.9,
          highlight: ['tiles', 'sites'],
          caption: 'The results: hands converted, files, hands saved, and hands Rail refused rather than guess at.',
          seconds: 5,
        },
        {
          shot: 'results',
          focus: 'files',
          fill: 0.8,
          highlight: 'firstFile',
          caption: 'Each file shows its room, its hands and any skipped ones, with its own download.',
          seconds: 4.5,
        },
        {
          shot: 'file-detail',
          focus: 'file',
          fill: 0.8,
          cursor: 'download',
          highlight: 'file',
          caption: 'Detail lists what happened to a file. Download gives you its hands as tracker-ready text.',
          seconds: 4.5,
        },
        {
          shot: 'results',
          focus: 'firstHand',
          fill: 0.8,
          highlight: 'firstHand',
          caption: 'Every converted hand is listed with its stakes, cards, board, pot and your result.',
          seconds: 4.5,
        },
        {
          shot: 'preview',
          focus: 'dialog',
          fill: 0.6,
          highlight: ['replay', 'copy', 'download'],
          caption: 'Preview shows a hand as text, to copy, download or open in the replayer.',
          seconds: 4.5,
        },
        {
          shot: 'tabs',
          focus: 'tabs',
          fill: 0.7,
          highlight: ['library', 'status'],
          caption: 'The hands are now in your library: the Hand history tab appears and the count goes up.',
          seconds: 4.5,
        },
      ],
    },
    {
      title: 'One hand at a time',
      steps: [
        {
          shot: 'pasted',
          focus: 'replayer',
          fill: 0.85,
          highlight: 'save',
          cursor: 'save',
          caption: 'Paste a single hand and choose Replay it: it opens in the replayer, with a button to save it.',
          seconds: 5,
        },
        {
          shot: 'manual',
          highlight: ['game', 'players'],
          caption: 'No file at all? Enter a hand manually: set the game and the players, then click through the action.',
          seconds: 5,
        },
      ],
    },
  ],
};
