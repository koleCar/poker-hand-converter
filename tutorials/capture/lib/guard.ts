// The demo-data guard: no real person's name may appear in any frame.
//
// `npm run demo-data` writes two lists next to the demo hands (both
// gitignored, never committed):
//
// - `names.json`: every name a demo hand carries (the hero `RailDemo` and the
//   made-up opponents) - the demo name set;
// - `scrubbed.json`: every name the corpus files carried before the rewrite.
//
// Every captured frame's text is checked against both: a scrubbed name
// anywhere in the page's text (as a whole token), or a name in a place that
// shows players' names (`NAME_SELECTORS`) that is not in the demo set, fails
// the capture. The check runs before the screenshot is written.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';

import { DEMO_DIR } from './paths.ts';

interface NameLists {
  demo: Set<string>;
  scrubbed: string[];
}

let lists: NameLists | null = null;

function load(): NameLists {
  if (lists) return lists;
  const demoFile = join(DEMO_DIR, 'names.json');
  const scrubbedFile = join(DEMO_DIR, 'scrubbed.json');
  if (!existsSync(demoFile) || !existsSync(scrubbedFile)) {
    throw new Error('No demo name lists: run `npm run demo-data` first.');
  }
  const demo = new Set<string>(JSON.parse(readFileSync(demoFile, 'utf8')) as string[]);
  const scrubbed = (JSON.parse(readFileSync(scrubbedFile, 'utf8')) as string[]).filter(
    (name) => !demo.has(name),
  );
  lists = { demo, scrubbed };
  return lists;
}

/** Names the UI itself shows that are not players: pseudonyms and labels. */
const NOT_PLAYERS = /^(Hero|Villain\d*|You|BTN|SB|BB|UTG(\+\d)?|MP\d?|HJ|CO|LJ|EP|Seat \d+|Player \d+|—|-)$/;

/** Where the web and the app print a player's name. */
export const NAME_SELECTORS = [
  '.pseat__nick',
  '.rp__result-name',
  '[data-player-name]',
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether `name` stands in `text` as a whole token (not inside a word). */
export function containsToken(text: string, name: string): boolean {
  if (!name) return false;
  const re = new RegExp(`(^|[^\\p{L}\\p{N}_])${escape(name)}($|[^\\p{L}\\p{N}_])`, 'u');
  return re.test(text);
}

export interface GuardOptions {
  /** Extra selectors that hold player names on this screen. */
  nameSelectors?: string[];
  /** Text drawn outside the DOM (e.g. an SVG's labels) to check too. */
  extraText?: string;
  /**
   * Made-up names a mock serves (the desktop app's IPC mock) that are not
   * in the demo hands: accepted where player names are shown.
   */
  allowNames?: string[];
}

/** Throws when the page shows a name that is not demo data. */
export async function guardNames(page: Page, where: string, options: GuardOptions = {}): Promise<void> {
  const { demo, scrubbed } = load();
  const selectors = [...NAME_SELECTORS, ...(options.nameSelectors ?? [])];
  const { text, names } = await page.evaluate((sels: string[]) => {
    const parts: string[] = [document.title, document.body?.innerText ?? ''];
    // Attribute text a screenshot can show (tooltips are not captured, but
    // aria-labels feed visible captions in places) and form values.
    document.querySelectorAll<HTMLElement>('[aria-label],[title],input,textarea').forEach((el) => {
      parts.push(el.getAttribute('aria-label') ?? '', el.getAttribute('title') ?? '');
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) parts.push(el.value);
    });
    document.querySelectorAll('svg text').forEach((el) => parts.push(el.textContent ?? ''));
    const names: string[] = [];
    for (const sel of sels) {
      document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
        const value = el.getAttribute('data-player-name') ?? el.innerText ?? '';
        if (value.trim()) names.push(value.trim());
      });
    }
    return { text: parts.join('\n'), names };
  }, selectors);
  const all = `${text}\n${options.extraText ?? ''}`;
  const leaked = scrubbed.filter((name) => containsToken(all, name));
  const allowed = new Set(options.allowNames ?? []);
  const unknown = names.filter((name) => !demo.has(name) && !allowed.has(name) && !NOT_PLAYERS.test(name));
  if (leaked.length || unknown.length) {
    // Printed to this terminal only, to find the leak; never written to a file.
    throw new Error(
      `Name guard failed at ${where}: ` +
        (leaked.length ? `name(s) from the original corpus on screen: ${leaked.join(', ')}` : '') +
        (leaked.length && unknown.length ? '; ' : '') +
        (unknown.length ? `player name(s) not in the demo set: ${unknown.join(', ')}` : ''),
    );
  }
}

/** The demo name set, for a mock that needs names (the desktop app's IPC). */
export function demoNames(): string[] {
  return [...load().demo];
}
