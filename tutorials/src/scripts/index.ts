// Every tutorial, in the series' order (docs/GUIDE.md's sections; the parts
// split off for length follow their feature).

import { script as account } from './account.ts';
import { script as analysis } from './analysis.ts';
import { script as analysisCharts } from './analysis-charts.ts';
import { script as analysisLeaks } from './analysis-leaks.ts';
import { script as analysisSession } from './analysis-session.ts';
import { script as community } from './community.ts';
import { script as convert } from './convert.ts';
import { script as desktopApp } from './desktop-app.ts';
import { script as desktopSetup } from './desktop-setup.ts';
import { script as gettingStarted } from './getting-started.ts';
import { script as hud } from './hud.ts';
import { script as hudEditor } from './hud-editor.ts';
import { script as learn } from './learn.ts';
import { script as library } from './library.ts';
import { script as players } from './players.ts';
import { script as replayer } from './replayer.ts';
import { script as stats } from './stats.ts';
import type { Tutorial } from './types.ts';

export const SCRIPTS: Tutorial[] = [
  gettingStarted,
  convert,
  library,
  replayer,
  stats,
  players,
  analysis,
  analysisSession,
  analysisLeaks,
  analysisCharts,
  learn,
  community,
  account,
  desktopSetup,
  desktopApp,
  hud,
  hudEditor,
];

export function scriptOf(slug: string): Tutorial {
  const script = SCRIPTS.find((s) => s.slug === slug);
  if (!script) throw new Error(`No tutorial ${slug}`);
  return script;
}
