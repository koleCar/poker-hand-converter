// Inter, the font the web and the app bundle (copied by `npm run assets`),
// loaded before the first frame is taken.

import { continueRender, delayRender, staticFile } from 'remotion';

const FILES = [
  { file: 'inter-v4.1-latin.woff2', range: 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215' },
  { file: 'inter-v4.1-latin-ext.woff2', range: 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+1E00-1E9F, U+20A0-20AB, U+20AD-20C0, U+2C60-2C7F, U+A720-A7FF' },
];

let started = false;

export function loadFonts(): void {
  if (started || typeof document === 'undefined') return;
  started = true;
  const handle = delayRender('Loading Inter');
  Promise.all(
    FILES.map(async ({ file, range }) => {
      const face = new FontFace('Inter', `url(${staticFile(`fonts/${file}`)}) format("woff2")`, {
        weight: '400 800',
        unicodeRange: range,
      });
      await face.load();
      document.fonts.add(face);
    }),
  )
    .catch((err) => console.warn('Inter did not load; run `npm run assets`.', err))
    .finally(() => continueRender(handle));
}
