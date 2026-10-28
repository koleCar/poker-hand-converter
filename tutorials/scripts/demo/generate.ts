// Demo hand files from the committed corpus, with every person scrubbed.
//
// The repository is public and so will the videos be: no real player's name
// may reach a frame. Source files are the real exports already committed
// (`weplay-hh/`: one account's sessions, so the hero's statistics add up). For each file:
//
// 1. The Rust core (`rail-convert --json`) reads it; every player's name is
//    collected, the hero's too.
// 2. Every name gets a made-up one (scripts/demo/names.ts), the same across
//    files, so a regular stays one player; every hero becomes `RailDemo`.
// 3. The text is rewritten: names replaced wherever they stand as a whole
//    token, longest first, in one pass; chat lines dropped; e-mail addresses
//    replaced; every hand moved in time by one shift, so the newest hand is
//    two days before today (sessions and their gaps unchanged).
// 4. The rewritten file is read again and must give the same hands - seats,
//    stacks, cards, actions, amounts, board, winners - with the names
//    mapped. A file that does not is left out, and no file may still contain
//    one of the original names as a token.
//
// Output (gitignored): `tutorials/.demo/hands/*.txt` with neutral file names
// (the source folders are named after the account), `names.json` (the demo
// name set) and `scrubbed.json` (the original names, for the capture guard).

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEMO_DIR, DEMO_HANDS, HERO, REPO } from '../../capture/lib/paths.ts';
import { NameSource } from './names.ts';

interface PhfPlayer {
  name: string;
  seat: number;
  isHero: boolean;
  startingStack: number;
  holeCards: string[];
  position: string | null;
}
interface PhfAction {
  type: string;
  player: string | null;
  amount: number;
  street: string;
}
interface PhfHand {
  playedAt: string;
  players: PhfPlayer[];
  actions: PhfAction[];
  board: unknown;
  table: { name: string | null } | null;
  meta: { handId: string };
  results: { totalPot: number; winners: { player: string; amount: number }[] };
}

// (`gg-hh/` is not a room's export: it holds the GG-style text Rail itself
// writes, which the converter labels "Rail standard".)
const SOURCES: { dir: string; room: string }[] = [{ dir: 'weplay-hh', room: 'weplay' }];

const CONVERT = join(REPO, 'target', 'release', process.platform === 'win32' ? 'rail-convert.exe' : 'rail-convert');

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (/\.txt$/i.test(entry)) out.push(path);
  }
  return out;
}

function convert(path: string): PhfHand[] {
  const out = spawnSync(CONVERT, ['--json', path], { encoding: 'utf8', maxBuffer: 1 << 30 });
  if (out.status !== 0) throw new Error(`rail-convert failed on a corpus file: ${out.stderr}`);
  return JSON.parse(out.stdout) as PhfHand[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORD = '\\p{L}\\p{N}_';

/** Replace each name standing as a whole token, longest first, in one pass. */
function replaceTokens(text: string, map: Map<string, string>): string {
  const names = [...map.keys()].sort((a, b) => b.length - a.length);
  if (!names.length) return text;
  const re = new RegExp(`(?<![${WORD}])(?:${names.map(escape).join('|')})(?![${WORD}])`, 'gu');
  return text.replace(re, (m) => map.get(m) ?? m);
}

const STAMP = /(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{2}):(\d{2})/g;
const pad = (n: number, width: number) => String(n).padStart(width, '0');

/** Move every `YYYY/M/D H:MM:SS` by `shiftMs`, keeping each field's width. */
function shiftStamps(text: string, shiftMs: number): string {
  return text.replace(STAMP, (_m, y, mo, d, h, mi, s) => {
    const t = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) + shiftMs);
    return (
      `${t.getUTCFullYear()}/${pad(t.getUTCMonth() + 1, mo.length)}/${pad(t.getUTCDate(), d.length)} ` +
      `${pad(t.getUTCHours(), h.length)}:${pad(t.getUTCMinutes(), 2)}:${pad(t.getUTCSeconds(), 2)}`
    );
  });
}

/** What must survive the rewrite, with the names mapped. */
function shape(hand: PhfHand, map: (n: string) => string, shiftMs: number): string {
  return JSON.stringify({
    at: new Date(Date.parse(hand.playedAt) + shiftMs).toISOString(),
    id: hand.meta.handId,
    players: hand.players.map((p) => [p.seat, map(p.name), p.isHero, p.startingStack, p.holeCards, p.position]),
    actions: hand.actions.map((a) => [a.type, a.player === null ? null : map(a.player), a.amount, a.street]),
    board: hand.board,
    pot: hand.results.totalPot,
    winners: hand.results.winners.map((w) => [map(w.player), w.amount]),
  });
}

export interface Generated {
  files: number;
  hands: number;
  dropped: number;
  names: number;
}

export function generate(): Generated {
  console.log('Building the Rust core converter (rail-convert)...');
  execFileSync('cargo', ['build', '--release', '--locked', '-p', 'rail-core', '--bin', 'rail-convert'], {
    cwd: REPO,
    stdio: 'inherit',
  });

  // Read everything first: the cast and the time shift are global.
  const inputs = SOURCES.flatMap(({ dir, room }) =>
    files(join(REPO, dir)).map((path) => ({ path, room, hands: convert(path) })),
  ).filter((f) => f.hands.length > 0);

  const realNames = new Set<string>();
  const heroes = new Set<string>();
  let newest = 0;
  for (const input of inputs) {
    for (const hand of input.hands) {
      newest = Math.max(newest, Date.parse(hand.playedAt));
      for (const p of hand.players) {
        realNames.add(p.name);
        if (p.isHero) heroes.add(p.name);
      }
    }
  }

  // The newest hand lands two days ago, at the same time of day.
  const day = 24 * 3600 * 1000;
  const target = new Date();
  target.setUTCHours(new Date(newest).getUTCHours(), new Date(newest).getUTCMinutes(), 0, 0);
  const shiftMs = Math.round((target.getTime() - 2 * day - newest) / 1000) * 1000;

  const source = new NameSource(20261027);
  source.reserve(HERO);
  const cast = new Map<string, string>();
  for (const input of inputs) {
    for (const hand of input.hands) {
      for (const p of hand.players) {
        if (cast.has(p.name)) continue;
        cast.set(p.name, heroes.has(p.name) ? HERO : source.fresh(realNames));
      }
    }
  }
  const mapName = (n: string) => cast.get(n) ?? n;
  const anyReal = new RegExp(
    `(?<![${WORD}])(?:${[...realNames].sort((a, b) => b.length - a.length).map(escape).join('|')})(?![${WORD}])`,
    'u',
  );

  rmSync(DEMO_HANDS, { recursive: true, force: true });
  mkdirSync(DEMO_HANDS, { recursive: true });
  const counters: Record<string, number> = {};
  let hands = 0;
  let dropped = 0;
  let written = 0;
  const used = new Set<string>();
  for (const input of inputs) {
    const raw = readFileSync(input.path);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      dropped++;
      continue; // Only UTF-8 sources: a re-encoding is not worth the risk.
    }
    // Every known name, not only this file's players: a regular may be
    // named in a line of a hand they did not play (joining, leaving).
    let out = replaceTokens(text, cast);
    // Chat and anything that looks like an e-mail address.
    out = out
      .split(/(?<=\n)/)
      .filter((line) => !/^[^\n]{1,64} said, "/.test(line))
      .join('');
    out = out.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, 'demo@rail.test');
    out = shiftStamps(out, shiftMs);

    counters[input.room] = (counters[input.room] ?? 0) + 1;
    const name = `${input.room}-demo-${pad(counters[input.room], 3)}.txt`;
    const path = join(DEMO_HANDS, name);
    writeFileSync(path, out);

    // Read it back: the same hands, names mapped, and nothing original left.
    const again = convert(path);
    const before = input.hands.map((h) => shape(h, mapName, shiftMs));
    const after = again.map((h) => shape(h, (n) => n, 0));
    const leaked = anyReal.test(out);
    if (before.length !== after.length || before.some((s, i) => s !== after[i]) || leaked) {
      if (process.env.RAIL_DEMO_DEBUG) {
        const i = before.findIndex((x, k) => x !== after[k]);
        console.log(`dropped ${name}: ${before.length}/${after.length} hands, leaked=${leaked}, first diff at ${i}`);
        if (i >= 0) console.log(`  before ${before[i]?.slice(0, 600)}\n  after  ${after[i]?.slice(0, 600)}`);
      }
      rmSync(path);
      dropped++;
      continue;
    }
    for (const h of again) for (const p of h.players) used.add(p.name);
    hands += again.length;
    written++;
  }

  const demoNames = [...used].sort();
  writeFileSync(join(DEMO_DIR, 'names.json'), `${JSON.stringify(demoNames, null, 0)}\n`);
  // `Hero` is GG's own placeholder for the account, not anybody's name.
  const scrubbed = [...realNames].filter((n) => n !== 'Hero').sort();
  writeFileSync(join(DEMO_DIR, 'scrubbed.json'), `${JSON.stringify(scrubbed, null, 0)}\n`);
  writeFileSync(
    join(DEMO_DIR, 'README.txt'),
    'Generated by `npm run demo-data` (tutorials/scripts/demo/generate.ts). Never commit anything here.\n',
  );
  return { files: written, hands, dropped, names: demoNames.length };
}
