// `npm run assets`: what the compositions load besides the captures, copied
// from the repository rather than duplicated in it - Rail's Inter (with its
// licence) from `web/public/fonts/`. Gitignored; `studio` and `render` run it.

import { cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { REPO, TUTORIALS } from '../capture/lib/paths.ts';

const fonts = join(TUTORIALS, 'public', 'fonts');
mkdirSync(fonts, { recursive: true });
for (const file of ['inter-v4.1-latin.woff2', 'inter-v4.1-latin-ext.woff2']) {
  cpSync(join(REPO, 'web', 'public', 'fonts', file), join(fonts, file));
}
cpSync(join(REPO, 'app', 'public', 'fonts', 'OFL.txt'), join(fonts, 'OFL.txt'));
