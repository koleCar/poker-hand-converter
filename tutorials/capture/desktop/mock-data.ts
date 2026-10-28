// The desktop app's demo data, made up from scratch: the hero `RailDemo`,
// opponents with names from the table simulator's word lists
// (`hud/rail-hud-sim/src/names.rs`: Adjective + Animal + a number, seeded so
// every run gets the same ones), plausible stakes at PokerStars, Winamax and
// WePlay, generic folder paths and `demo@rail.test`. Nothing here comes from a
// hand history: the one hand the replayer opens is written below, and its
// "raw text" is printed from it.
//
// What is real: the statistic definitions (`config/stats/standard.json`), the
// HUD presets (`config/hud/presets.json`) and the rooms' HUD policies
// (`config/sites.json`) - the app ships them, the mock serves them as the
// Rust side would.
//
// Everything is computed in Node and handed to the page's init script
// (`tauri-mock.ts`) as one JSON object.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ACCOUNTS, HERO, REPO } from '../lib/paths.ts';
import type {
  AccountStatus,
  AppInfo,
  Breakdowns,
  CoreInfo,
  CustomList,
  Definition,
  Discovery,
  EntitlementsStatus,
  FacetCount,
  GameFormat,
  GroupRow,
  HandFacets,
  HandRow,
  HudCheck,
  HudDesign,
  HudEditorState,
  HudPolicy,
  HudPopup,
  HudPreset,
  HudRestrictions,
  HudRoom,
  HudStat,
  HudStatus,
  LeakExampleDto,
  PhfAction,
  PhfHand,
  PhfPlayer,
  PhfPlayerResult,
  PlayerNotes,
  PlayerProfile,
  PlayerRow,
  PopupBand,
  QuarantineList,
  QuarantineSummary,
  Report,
  ReviewDecision,
  ReviewHandDto,
  ReviewSessionRow,
  SessionReviewDto,
  RoomChoice,
  RoomPolicy,
  SavedFilter,
  Session,
  Settings,
  Shown,
  StatBand,
  StatDefinition,
  StatsStatus,
  StatTone,
  StoreStatus,
  SyncStatus,
  TopLeaksDto,
  WatchSource,
  WatchStatus,
} from './ipc-types.ts';

/* ------------------------------------------------------------ randomness - */

/** mulberry32: a small seeded generator, so every run makes the same data. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(random: () => number, list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
const between = (random: () => number, low: number, high: number) => low + Math.floor(random() * (high - low + 1));

/* ----------------------------------------------------------------- names - */

// `hud/rail-hud-sim/src/names.rs`' word lists and its three patterns.
const FIRST = [
  'Silent', 'Lucky', 'River', 'Turbo', 'Quiet', 'Grumpy', 'Shady', 'Mighty', 'Lazy', 'Brave',
  'Crafty', 'Dizzy', 'Frosty', 'Golden', 'Hasty', 'Jolly', 'Keen', 'Lofty', 'Moody', 'Nifty',
  'Plucky', 'Rusty', 'Salty', 'Tipsy', 'Witty', 'Zesty', 'Bluff', 'Snappy', 'Gritty', 'Sneaky',
  'Wobbly', 'Cosmic',
];
const SECOND = [
  'Shark', 'Donk', 'Fish', 'Rat', 'Owl', 'Tiger', 'Mole', 'Crab', 'Whale', 'Fox', 'Bear', 'Hawk',
  'Badger', 'Otter', 'Panda', 'Moose', 'Gecko', 'Llama', 'Raven', 'Bison', 'Cobra', 'Lynx',
  'Mantis', 'Newt', 'Pike', 'Quail', 'Squid', 'Toad', 'Viper', 'Wasp', 'Yak', 'Zebu',
];

/** `count` made-up screen names, never the hero's nor a demo account's. */
export function opponentNames(count: number, seed = 20261027): string[] {
  const random = seeded(seed);
  const used = new Set<string>([HERO, ...Object.values(ACCOUNTS).map((a) => a.username)]);
  const out: string[] = [];
  while (out.length < count) {
    const first = pick(random, FIRST);
    const second = pick(random, SECOND);
    const style = Math.floor(random() * 3);
    const name =
      style === 0
        ? `${first}${second}${between(random, 1, 99)}`
        : style === 1
          ? `${first.toLowerCase()}_${second}${between(random, 1, 9)}`
          : `${second}_${first}${between(random, 10, 999)}`;
    if (!used.has(name)) {
      used.add(name);
      out.push(name);
    }
  }
  return out;
}

/* ---------------------------------------------------------- the shipped - */

const readJson = <T>(path: string): T => JSON.parse(readFileSync(join(REPO, path), 'utf8')) as T;

interface SiteEntry {
  id: string;
  name: string;
  kind: 'room' | 'network' | 'format';
  parser?: string | null;
  hud: {
    allowed: boolean | null;
    source: string | null;
    checkedAt: string | null;
    notes?: string;
    restrictions?: HudRestrictions | null;
  };
}

/* ------------------------------------------------------------ statistics - */

function formatFixed(value: number, decimals: number): string {
  const text = value.toFixed(decimals);
  return /^-0(\.0+)?$/.test(text) ? text.slice(1) : text;
}

function toneOf(bands: readonly StatBand[], value: number): StatTone | null {
  const band = bands.find((b) => b.below === undefined || value < b.below);
  return band ? band.tone : null;
}

const WILSON_Z = 1.959964;

function wilson(made: number, n: number): { low: number; high: number } | null {
  if (!(n > 0) || made < 0 || made > n) return null;
  const z2 = WILSON_Z * WILSON_Z;
  const centre = made + z2 / 2;
  const spread = WILSON_Z * Math.sqrt((made * (n - made)) / n + z2 / 4);
  const denominator = n + z2;
  const low = made === 0 ? 0 : ((centre - spread) * 100) / denominator;
  const high = made === n ? 100 : ((centre + spread) * 100) / denominator;
  return { low: Math.max(0, low), high: Math.min(100, high) };
}

function reliability(sample: number | null, min: number): { level: Shown['reliability']['level']; opacity: number } {
  if (min === 0) return { level: 'ok', opacity: 1 };
  if (sample === null || !(sample > 0)) return { level: 'insufficient', opacity: 0.6 };
  if (!(sample < min)) return { level: 'ok', opacity: 1 };
  return { level: sample * 4 < min ? 'insufficient' : 'low', opacity: 0.6 + 0.4 * Math.sqrt(sample / min) };
}

const NONE: Shown = {
  value: null,
  text: null,
  tone: null,
  sample: null,
  full: false,
  reliability: { level: 'insufficient', opacity: 0.6, interval: null, intervalText: null },
};

/** A rate `percent` over `opportunities` (rounded to whole hands), as `rail_stats` shows it. */
function shownRate(def: StatDefinition, percent: number, opportunities: number, bands = def.bands): Shown {
  const opp = Math.max(0, Math.round(opportunities));
  if (opp === 0) return { ...NONE, sample: 0 };
  const made = Math.min(opp, Math.max(0, Math.round((percent / 100) * opp)));
  const value = (made * 100) / opp;
  const interval = wilson(made, opp);
  const { level, opacity } = reliability(opp, def.sample.min);
  return {
    value,
    text: formatFixed(value, def.format.decimals),
    tone: toneOf(bands, value),
    sample: opp,
    full: def.sample.min === 0 || opp >= def.sample.min,
    reliability: {
      level,
      opacity,
      interval,
      intervalText: interval
        ? { low: formatFixed(interval.low, def.format.decimals), high: formatFixed(interval.high, def.format.decimals) }
        : null,
    },
  };
}

/** A value that is not a rate (a count, bb/100, a ratio, money in minor units). */
function shownValue(def: StatDefinition, value: number | null, sample: number, minorUnits: number | null = null): Shown {
  if (value === null) return { ...NONE, sample };
  const { level, opacity } = reliability(sample, def.sample.min);
  const text =
    def.format.unit === 'money'
      ? minorUnits === null
        ? null
        : formatFixed(value / minorUnits, def.format.decimals)
      : formatFixed(value, def.format.decimals);
  return {
    value,
    text,
    tone: toneOf(def.bands, value),
    sample,
    full: def.sample.min === 0 || sample >= def.sample.min,
    reliability: { level, opacity, interval: null, intervalText: null },
  };
}

/** How many opportunities a statistic has per hand dealt (a typical 6-max sample). */
const OPPORTUNITIES: Record<string, number> = {
  vpip: 0.97,
  pfr: 0.97,
  rfi: 0.42,
  limp: 0.42,
  iso: 0.07,
  cold_call: 0.28,
  three_bet: 0.3,
  fold_to_three_bet: 0.07,
  four_bet: 0.05,
  fold_to_four_bet: 0.025,
  squeeze: 0.06,
  steal: 0.13,
  fold_to_steal: 0.12,
  saw_flop: 1,
  cbet_flop: 0.1,
  cbet_turn: 0.05,
  cbet_river: 0.025,
  fold_to_cbet_flop: 0.08,
  fold_to_cbet_turn: 0.035,
  raise_cbet_flop: 0.08,
  donk_flop: 0.06,
  check_raise_flop: 0.07,
  aggression_frequency: 0.45,
  wwsf: 0.3,
  wtsd: 0.3,
  wsd: 0.085,
};

/** A player's tendencies: every rate in percent, the aggression factor, the win rate. */
type Profile = Record<string, number>;

const HERO_PROFILE: Profile = {
  vpip: 24.1, pfr: 19.6, rfi: 27.4, limp: 1.1, iso: 22.0, cold_call: 7.9, three_bet: 8.6, fold_to_three_bet: 51.2,
  four_bet: 7.4, fold_to_four_bet: 47.0, squeeze: 7.1, steal: 41.5, fold_to_steal: 63.0, saw_flop: 30.8,
  cbet_flop: 62.3, cbet_turn: 49.0, cbet_river: 43.2, fold_to_cbet_flop: 43.5, fold_to_cbet_turn: 46.0,
  raise_cbet_flop: 9.4, donk_flop: 3.8, check_raise_flop: 8.7, aggression_factor: 2.64, aggression_frequency: 42.1,
  wwsf: 47.6, wtsd: 28.3, wsd: 53.4, bb_per_100: 6.42, allin_ev_bb_per_100: 4.88,
};

const TYPES: Record<string, Profile> = {
  reg: {
    vpip: 22.5, pfr: 18.9, rfi: 26.0, limp: 0.8, iso: 21.0, cold_call: 6.5, three_bet: 7.8, fold_to_three_bet: 56.0,
    four_bet: 6.2, fold_to_four_bet: 52.0, squeeze: 6.0, steal: 39.0, fold_to_steal: 66.0, saw_flop: 29.0,
    cbet_flop: 64.0, cbet_turn: 51.0, cbet_river: 44.0, fold_to_cbet_flop: 45.0, fold_to_cbet_turn: 48.0,
    raise_cbet_flop: 8.5, donk_flop: 3.1, check_raise_flop: 7.9, aggression_factor: 2.4, aggression_frequency: 40.5,
    wwsf: 46.0, wtsd: 27.0, wsd: 52.0, bb_per_100: 2.1,
  },
  fish: {
    vpip: 46.0, pfr: 9.5, rfi: 18.0, limp: 24.0, iso: 9.0, cold_call: 31.0, three_bet: 3.1, fold_to_three_bet: 38.0,
    four_bet: 2.0, fold_to_four_bet: 31.0, squeeze: 1.8, steal: 21.0, fold_to_steal: 48.0, saw_flop: 52.0,
    cbet_flop: 41.0, cbet_turn: 33.0, cbet_river: 29.0, fold_to_cbet_flop: 33.0, fold_to_cbet_turn: 36.0,
    raise_cbet_flop: 5.5, donk_flop: 13.0, check_raise_flop: 4.2, aggression_factor: 1.15, aggression_frequency: 27.0,
    wwsf: 41.0, wtsd: 37.5, wsd: 46.0, bb_per_100: -18.4,
  },
  nit: {
    vpip: 14.2, pfr: 11.8, rfi: 16.0, limp: 0.5, iso: 12.0, cold_call: 4.0, three_bet: 3.9, fold_to_three_bet: 71.0,
    four_bet: 3.0, fold_to_four_bet: 66.0, squeeze: 2.4, steal: 24.0, fold_to_steal: 81.0, saw_flop: 19.5,
    cbet_flop: 71.0, cbet_turn: 58.0, cbet_river: 49.0, fold_to_cbet_flop: 58.0, fold_to_cbet_turn: 61.0,
    raise_cbet_flop: 4.5, donk_flop: 2.0, check_raise_flop: 5.0, aggression_factor: 2.1, aggression_frequency: 36.0,
    wwsf: 43.0, wtsd: 24.0, wsd: 56.0, bb_per_100: -1.2,
  },
  lag: {
    vpip: 33.0, pfr: 27.5, rfi: 38.0, limp: 0.6, iso: 34.0, cold_call: 8.0, three_bet: 12.8, fold_to_three_bet: 44.0,
    four_bet: 11.0, fold_to_four_bet: 40.0, squeeze: 11.5, steal: 52.0, fold_to_steal: 55.0, saw_flop: 35.0,
    cbet_flop: 72.0, cbet_turn: 58.0, cbet_river: 52.0, fold_to_cbet_flop: 38.0, fold_to_cbet_turn: 40.0,
    raise_cbet_flop: 15.0, donk_flop: 5.0, check_raise_flop: 13.5, aggression_factor: 3.6, aggression_frequency: 51.0,
    wwsf: 50.0, wtsd: 26.0, wsd: 50.5, bb_per_100: 0.8,
  },
};

/** Every definition over `hands` hands of a player who plays like `profile`, in `definitions`' order. */
function statsFor(
  definitions: readonly Definition[],
  profile: Profile,
  hands: number,
  options: { hero: boolean; minorUnits: number | null; random: () => number },
): Shown[] {
  const jitter = (value: number) => value * (0.93 + options.random() * 0.14);
  const moneyHands = hands;
  return definitions.map((def) => {
    if (def.players === 'hero' && !options.hero) return { ...NONE };
    switch (def.id) {
      case 'hands':
        return shownValue(def, hands, hands);
      case 'bb_per_100':
      case 'allin_ev_bb_per_100':
        return shownValue(def, profile[def.id] ?? 0, moneyHands);
      case 'net_bb':
        return shownValue(def, ((profile.bb_per_100 ?? 0) * moneyHands) / 100, moneyHands);
      case 'rake_per_100':
        return shownValue(def, Math.round(jitter(410)), moneyHands, options.minorUnits);
      case 'aggression_factor':
        return shownValue(def, jitter(profile.aggression_factor ?? 2), Math.round(hands * 0.45));
      default: {
        const rate = profile[def.id];
        if (rate === undefined) return { ...NONE };
        return shownRate(def, jitter(rate), hands * (OPPORTUNITIES[def.id] ?? 0.1));
      }
    }
  });
}

/** The statistics a breakdown row shows (`@rail/ui/reports/model` BREAKDOWN_COLUMNS). */
const BREAKDOWN_COLUMNS = ['hands', 'bb_per_100', 'vpip', 'pfr', 'rfi', 'three_bet', 'fold_to_three_bet', 'steal', 'cbet_flop', 'wtsd', 'wsd'];

function groupRow(
  definitions: readonly Definition[],
  key: string,
  label: string | null,
  hands: number,
  profile: Profile,
  bbPer100: number,
  random: () => number,
  netPerBb: number | null = null,
): GroupRow {
  const byId = new Map(definitions.map((d) => [d.id, d]));
  const all = statsFor(definitions, { ...profile, bb_per_100: bbPer100 }, hands, { hero: true, minorUnits: 100, random });
  const stats = BREAKDOWN_COLUMNS.map((id) => all[definitions.findIndex((d) => d.id === id)] ?? NONE);
  void byId;
  const netBbMilli = Math.round(bbPer100 * hands * 10);
  return {
    key,
    label,
    hands,
    moneyHands: hands,
    net: netPerBb === null ? null : Math.round((netBbMilli / 1000) * netPerBb),
    netBbMilli,
    stats,
  };
}

/* ---------------------------------------------------------------- rooms - */

const STAKES = {
  pokerstars: { site: 'pokerstars', siteName: 'PokerStars', currency: 'USD', symbol: '$', sb: 25, bb: 50, prefix: 'PS' },
  winamax: { site: 'winamax', siteName: 'Winamax', currency: 'EUR', symbol: '€', sb: 10, bb: 25, prefix: 'WM' },
  weplay: { site: 'weplay', siteName: 'WePlay', currency: 'USD', symbol: '$', sb: 50, bb: 100, prefix: 'WP' },
} as const;
type RoomKey = keyof typeof STAKES;

const TABLES: Record<RoomKey, string[]> = {
  pokerstars: ['Vega IV', 'Altair II', 'Deneb III'],
  winamax: ['Lyon 12', 'Nantes 04'],
  weplay: ['NLH Daily 7'],
};

const HOME = '/Users/demo';
export const FOLDERS = {
  pokerstars: `${HOME}/Library/Application Support/PokerStars/HandHistory/${HERO}`,
  weplay: `${HOME}/Documents/hands/${HERO}`,
  winamax: `${HOME}/Library/Application Support/winamax/documents/accounts/${HERO}/history`,
};

/* ----------------------------------------------------------------- cards - */

const RANKS = '23456789TJQKA';
const SUITS = 'cdhs';
const DECK = [...RANKS].flatMap((r) => [...SUITS].map((s) => `${r}${s}`));

function deal(random: () => number, count: number, taken: Set<string>): string[] {
  const out: string[] = [];
  while (out.length < count) {
    const card = pick(random, DECK);
    if (!taken.has(card)) {
      taken.add(card);
      out.push(card);
    }
  }
  return out;
}

/* ------------------------------------------------------- the open hand - */

/** The hand the replayer opens: a 3-bet pot at PokerStars, written out move by move. */
function scriptedHand(names: string[], playedAt: Date): { phf: PhfHand; row: HandRow } {
  const handId = '250102938475';
  const handKey = `PS${handId}`;
  const table = 'Vega IV';
  const unit = { code: 'USD', symbol: '$', minorUnits: 100, kind: 'cash' as const };
  const money = (cents: number) => (cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);
  const [utg, hj, co, sb, bb] = names as [string, string, string, string, string];
  const seats: { seat: number; name: string; stack: number; position: PhfPlayer['position'] }[] = [
    { seat: 1, name: utg, stack: 5000, position: 'UTG' },
    { seat: 2, name: hj, stack: 6230, position: 'HJ' },
    { seat: 3, name: co, stack: 4875, position: 'CO' },
    { seat: 4, name: HERO, stack: 5000, position: 'BTN' },
    { seat: 5, name: sb, stack: 5410, position: 'SB' },
    { seat: 6, name: bb, stack: 3925, position: 'BB' },
  ];
  const seatOf = (name: string) => seats.find((s) => s.name === name)?.seat ?? null;
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${playedAt.getUTCFullYear()}/${pad(playedAt.getUTCMonth() + 1)}/${pad(playedAt.getUTCDate())} ${pad(
    playedAt.getUTCHours(),
  )}:${pad(playedAt.getUTCMinutes())}:${pad(playedAt.getUTCSeconds())} UTC`;

  const lines: string[] = [
    `PokerStars Hand #${handId}:  Hold'em No Limit (${money(25)}/${money(50)} USD) - ${stamp}`,
    `Table '${table}' 6-max Seat #4 is the button`,
    ...seats.map((s) => `Seat ${s.seat}: ${s.name} (${money(s.stack)} in chips) `),
  ];
  const actions: PhfAction[] = [];
  const act = (
    street: PhfAction['street'],
    player: string,
    type: PhfAction['type'],
    amount: number,
    streetTotal: number,
    label: string,
    rawLine: string,
    extra: Partial<PhfAction> = {},
  ) => {
    lines.push(rawLine);
    actions.push({
      index: actions.length,
      street,
      runoutIndex: 0,
      seat: seatOf(player),
      player,
      type,
      amount,
      streetTotal,
      allIn: false,
      label,
      sourceLine: lines.length,
      rawLine,
      ...extra,
    });
  };
  act('preflop', sb, 'small-blind', 25, 25, `small blind ${money(25)}`, `${sb}: posts small blind ${money(25)}`);
  act('preflop', bb, 'big-blind', 50, 50, `big blind ${money(50)}`, `${bb}: posts big blind ${money(50)}`);
  lines.push('*** HOLE CARDS ***', `Dealt to ${HERO} [As Kd]`);
  act('preflop', utg, 'fold', 0, 0, 'folds', `${utg}: folds `);
  act('preflop', hj, 'raise', 125, 125, `raises to ${money(125)}`, `${hj}: raises ${money(75)} to ${money(125)}`);
  act('preflop', co, 'fold', 0, 0, 'folds', `${co}: folds `);
  act('preflop', HERO, 'raise', 375, 375, `raises to ${money(375)}`, `${HERO}: raises ${money(250)} to ${money(375)}`);
  act('preflop', sb, 'fold', 0, 25, 'folds', `${sb}: folds `);
  act('preflop', bb, 'fold', 0, 50, 'folds', `${bb}: folds `);
  act('preflop', hj, 'call', 250, 375, `calls ${money(250)}`, `${hj}: calls ${money(250)}`);
  lines.push('*** FLOP *** [Kh 7c 2d]');
  act('flop', hj, 'check', 0, 0, 'checks', `${hj}: checks `);
  act('flop', HERO, 'bet', 400, 400, `bets ${money(400)}`, `${HERO}: bets ${money(400)}`);
  act('flop', hj, 'call', 400, 400, `calls ${money(400)}`, `${hj}: calls ${money(400)}`);
  lines.push('*** TURN *** [Kh 7c 2d] [9s]');
  act('turn', hj, 'check', 0, 0, 'checks', `${hj}: checks `);
  act('turn', HERO, 'bet', 1050, 1050, `bets ${money(1050)}`, `${HERO}: bets ${money(1050)}`);
  act('turn', hj, 'call', 1050, 1050, `calls ${money(1050)}`, `${hj}: calls ${money(1050)}`);
  lines.push('*** RIVER *** [Kh 7c 2d 9s] [3h]');
  act('river', hj, 'check', 0, 0, 'checks', `${hj}: checks `);
  act('river', HERO, 'check', 0, 0, 'checks', `${HERO}: checks `);
  lines.push('*** SHOW DOWN ***');
  act('showdown', hj, 'show', 0, 0, 'shows Qd Qc', `${hj}: shows [Qd Qc] (a pair of Queens)`, {
    cards: ['Qd', 'Qc'],
    description: 'a pair of Queens',
  });
  act('showdown', HERO, 'show', 0, 0, 'shows As Kd', `${HERO}: shows [As Kd] (a pair of Kings)`, {
    cards: ['As', 'Kd'],
    description: 'a pair of Kings',
  });
  act('showdown', HERO, 'collect', 3575, 0, `wins ${money(3575)}`, `${HERO} collected ${money(3575)} from pot`, {
    potName: 'pot',
  });

  const result = (
    seat: number,
    player: string,
    contributed: number,
    won: number,
    outcome: PhfPlayerResult['outcome'],
    raw: string,
    extra: Partial<PhfPlayerResult> = {},
  ): PhfPlayerResult => ({
    seat,
    player,
    won,
    contributed,
    net: won - contributed,
    wentToShowdown: false,
    shownCards: [],
    mucked: false,
    handDescription: null,
    positionLabels: [],
    outcome,
    foldedStreet: outcome === 'folded' ? 'preflop' : null,
    didntBet: outcome === 'folded' && contributed === 0,
    cashoutRisk: null,
    raw,
    ...extra,
  });
  const players: PhfPlayerResult[] = [
    result(1, utg, 0, 0, 'folded', `Seat 1: ${utg} folded before Flop (didn't bet)`),
    result(2, hj, 1825, 0, 'lost', `Seat 2: ${hj} showed [Qd Qc] and lost with a pair of Queens`, {
      wentToShowdown: true,
      shownCards: ['Qd', 'Qc'],
      handDescription: 'a pair of Queens',
    }),
    result(3, co, 0, 0, 'folded', `Seat 3: ${co} folded before Flop (didn't bet)`),
    result(4, HERO, 1825, 3575, 'won', `Seat 4: ${HERO} (button) showed [As Kd] and won (${money(3575)}) with a pair of Kings`, {
      wentToShowdown: true,
      shownCards: ['As', 'Kd'],
      handDescription: 'a pair of Kings',
      positionLabels: ['(button)'],
    }),
    result(5, sb, 25, 0, 'folded', `Seat 5: ${sb} (small blind) folded before Flop`, { positionLabels: ['(small blind)'] }),
    result(6, bb, 50, 0, 'folded', `Seat 6: ${bb} (big blind) folded before Flop`, { positionLabels: ['(big blind)'] }),
  ];
  lines.push(
    '*** SUMMARY ***',
    `Total pot ${money(3725)} | Rake ${money(150)} `,
    'Board [Kh 7c 2d 9s 3h]',
    ...players.map((p) => p.raw ?? ''),
  );

  const phf: PhfHand = {
    schema: 'phf/1',
    meta: {
      siteId: 'pokerstars',
      siteName: 'PokerStars',
      handId,
      handKey,
      originalFilename: `HH${stamp.slice(0, 10).replaceAll('/', '')} ${table} - $0.25-$0.50 - USD No Limit Hold'em.txt`,
      parserId: 'pokerstars',
      parserVersion: '1.0.0',
      warnings: [],
      rawText: `${lines.join('\n')}\n`,
      parsedAt: new Date(playedAt.getTime() + 2000).toISOString(),
      textStyle: {
        decimals: 'minimal',
        dealtLinesForAllPlayers: false,
        showdownSection: true,
        holeCardsSection: true,
        showdownLabels: [''],
        runItTwiceNote: false,
        padHour: false,
      },
    },
    game: {
      variant: 'holdem',
      limit: 'nl',
      hiLo: false,
      format: 'cash',
      unit,
      smallBlind: 25,
      bigBlind: 50,
      anteModel: 'none',
      ante: 0,
      straddles: [],
      bombPot: null,
      label: "Hold'em No Limit",
    },
    table: { name: table, maxSeats: 6, buttonSeat: 4 },
    tournament: null,
    players: seats.map((s) => ({
      seat: s.seat,
      name: s.name,
      startingStack: s.stack,
      isHero: s.name === HERO,
      holeCards: s.name === HERO ? ['As', 'Kd'] : s.name === hj ? ['Qd', 'Qc'] : [],
      bounty: null,
      sittingOut: false,
      position: s.position,
      dealtAnnounced: s.name === HERO,
      dealtCards: s.name === HERO ? ['As', 'Kd'] : [],
    })),
    actions,
    board: {
      runouts: [
        {
          index: 0,
          flop: ['Kh', '7c', '2d'],
          turn: '9s',
          river: '3h',
          markerLabels: { flop: '', turn: '', river: '' },
          summaryCards: ['Kh', '7c', '2d', '9s', '3h'],
        },
      ],
    },
    results: {
      totalPot: 3725,
      pots: [],
      fees: { rake: 150, jackpot: 0, bingo: 0, fortune: 0, tax: 0, other: 0 },
      players,
      winners: [{ player: HERO, seat: 4, amount: 3575, runoutIndex: 0 }],
      heroNet: 1750,
      wentToShowdown: true,
      streetReached: 'showdown',
    },
    playedAt: playedAt.toISOString(),
  };
  const row: HandRow = {
    handKey,
    site: 'pokerstars',
    siteName: 'PokerStars',
    siteHandId: handId,
    playedAt: playedAt.toISOString(),
    gameFormat: 'cash',
    variant: 'holdem',
    limitType: 'nl',
    currency: 'USD',
    currencySymbol: '$',
    minorUnits: 100,
    smallBlind: 25,
    bigBlind: 50,
    ante: 0,
    maxSeats: 6,
    tableName: table,
    heroPosition: 'BTN',
    heroCards: ['As', 'Kd'],
    board: ['Kh', '7c', '2d', '9s', '3h'],
    heroNet: 1750,
    heroNetBbMilli: 35000,
    allIn: false,
    evNet: null,
    evNetBbMilli: null,
    evPending: false,
    potType: '3bet',
    totalPot: 3725,
    showdown: true,
    hasNote: true,
    tags: ['review'],
  };
  return { phf, row };
}

/* ------------------------------------------------------------- the rows - */

const POSITIONS = ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'];
const POT_TYPES = ['single-raised', 'single-raised', 'single-raised', '3bet', 'limped', 'walk', '4bet+'];

/** Rows of today's session (the list's first). */
const SESSION_ROWS = 200;

function handRows(random: () => number, now: number, scripted: HandRow): HandRow[] {
  const rows: HandRow[] = [scripted];
  let at = Date.parse(scripted.playedAt ?? '') - 40_000;
  // Enough rows that a filter still fills the list: today's session (PokerStars,
  // three tables, a hand every 20-60 s), two days earlier at PokerStars,
  // yesterday's session at Winamax, an evening at WePlay.
  for (let i = 1; i < SESSION_ROWS + 400; i += 1) {
    const room: RoomKey =
      i < SESSION_ROWS + 180 ? 'pokerstars' : i < SESSION_ROWS + 320 ? 'winamax' : 'weplay';
    if (i === SESSION_ROWS) at = now - 2 * 24 * 3600_000;
    if (i === SESSION_ROWS + 180) at = now - 26 * 3600_000;
    if (i === SESSION_ROWS + 320) at = now - 3 * 24 * 3600_000;
    at -= (i < SESSION_ROWS ? between(random, 20, 60) : between(random, 25, 95)) * 1000;
    const stake = STAKES[room];
    const taken = new Set<string>();
    const heroCards = deal(random, 2, taken);
    const potType = pick(random, POT_TYPES);
    const streets = potType === 'walk' ? 0 : pick(random, [0, 0, 3, 3, 4, 5, 5]);
    const board = streets === 0 ? [] : deal(random, streets, taken);
    const showdown = streets === 5 && random() < 0.55;
    const potBb =
      potType === 'walk' ? 1.5 : streets === 0 ? between(random, 2, 9) + 0.5 : Math.round((6 + random() * 62) * 10) / 10;
    const totalPot = Math.round(potBb * stake.bb);
    const won = random() < 0.48;
    const heroNet = potType === 'walk' ? stake.sb : won ? Math.round(totalPot * 0.52) : -Math.round(totalPot * (streets === 0 ? 0.2 : 0.47));
    const allIn = showdown && random() < 0.2;
    const siteHandId = String(250102938475 - i * 7919 + between(random, 0, 50));
    rows.push({
      handKey: `${stake.prefix}${siteHandId}`,
      site: stake.site,
      siteName: stake.siteName,
      siteHandId,
      playedAt: new Date(at).toISOString(),
      gameFormat: 'cash',
      variant: 'holdem',
      limitType: 'nl',
      currency: stake.currency,
      currencySymbol: stake.symbol,
      minorUnits: 100,
      smallBlind: stake.sb,
      bigBlind: stake.bb,
      ante: 0,
      maxSeats: 6,
      tableName: pick(random, TABLES[room]),
      heroPosition: potType === 'walk' ? 'BB' : pick(random, POSITIONS),
      heroCards,
      board,
      heroNet,
      heroNetBbMilli: Math.round((heroNet / stake.bb) * 1000),
      allIn,
      evNet: allIn ? Math.round(heroNet * 0.6) : null,
      evNetBbMilli: allIn ? Math.round((heroNet / stake.bb) * 600) : null,
      evPending: false,
      potType,
      totalPot,
      showdown,
      hasNote: i === 9,
      tags: i === 9 ? ['bluff-catch'] : i === 23 ? ['review'] : [],
    });
  }
  return rows;
}

function facetsOf(rows: readonly HandRow[], total: number): HandFacets {
  const scale = total / rows.length;
  const count = (key: (row: HandRow) => string | null): FacetCount[] => {
    const map = new Map<string, number>();
    for (const row of rows) {
      const value = key(row);
      if (value !== null) map.set(value, (map.get(value) ?? 0) + 1);
    }
    return [...map].map(([value, n]) => ({ value, count: Math.round(n * scale) }));
  };
  const stacks = count((row) => (row.heroNetBbMilli !== null && row.heroNetBbMilli > 40000 ? '120+' : '80-120'));
  return {
    total,
    sites: count((row) => row.site).map((f) => ({ ...f, name: rows.find((r) => r.site === f.value)?.siteName ?? f.value })),
    formats: [{ value: 'cash', count: total }],
    variants: [{ value: 'holdem', count: total }],
    limits: [{ value: 'nl', count: total }],
    sizes: [{ value: '6max', count: total }],
    stakes: count((row) => `${row.currency}:${row.bigBlind}`).map((f) => {
      const row = rows.find((r) => `${r.currency}:${r.bigBlind}` === f.value);
      return {
        ...f,
        currency: row?.currency ?? null,
        currencySymbol: row?.currencySymbol ?? null,
        minorUnits: row?.minorUnits ?? null,
        smallBlind: row?.smallBlind ?? null,
        bigBlind: row?.bigBlind ?? null,
      };
    }),
    // Six seats take turns: each about a sixth of the hands.
    positions: ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'].map((value, index) => ({
      value,
      count: Math.round((total / 6) * (1 + ((index * 7) % 5 - 2) * 0.004)),
    })),
    potTypes: count((row) => row.potType),
    results: count((row) => (row.heroNet === null ? null : row.heroNet > 0 ? 'won' : row.heroNet < 0 ? 'lost' : 'even')),
    stacks,
    allIn: count((row) => (row.allIn ? 'yes' : 'no')),
    tags: [
      { value: 'review', count: 14 },
      { value: 'bluff-catch', count: 6 },
    ],
    noted: 9,
  };
}

/* ----------------------------------------------------------------- the HUD - */

const RULES: Record<string, HudRestrictions> = {};

function checkForRoom(design: HudDesign, rules: HudRestrictions, stats: readonly HudStat[]) {
  const out: HudCheck['problems'] = [];
  if (rules.noGameStateSwitching) {
    for (const cell of design.cells) if (cell.when) out.push({ code: 'gameStateSwitching', stat: cell.stat });
  }
  if (rules.maxColourThresholds !== null) {
    for (const cell of design.cells) {
      const stat = stats.find((s) => s.id === cell.stat);
      if (!stat) continue;
      const bands = design.overrides?.[cell.stat]?.bands ?? stat.bands;
      const count = Math.min(Math.max(0, bands.length - 1), design.maxColourThresholds ?? Infinity);
      if (count > rules.maxColourThresholds) {
        out.push({ code: 'colourThresholds', stat: cell.stat, count, max: rules.maxColourThresholds });
      }
    }
  }
  if (rules.noPlayerLabels && design.playerLabels) out.push({ code: 'labels' });
  return out;
}

/** The bands a popup shows under at most `max` thresholds (very low and very high fold into low and high). */
function collapse(bands: readonly StatBand[], max: number | null): PopupBand[] {
  if (max === null || bands.length - 1 <= max) return bands.map((b) => ({ below: b.below ?? null, tone: b.tone }));
  const low = bands.find((b) => b.tone === 'low');
  const normal = bands.find((b) => b.tone === 'normal');
  if (max >= 2 && low && normal) {
    return [
      { below: low.below ?? null, tone: 'low' },
      { below: normal.below ?? null, tone: 'normal' },
      { below: null, tone: 'high' },
    ];
  }
  if (max === 1 && low) return [{ below: low.below ?? null, tone: 'low' }, { below: null, tone: 'normal' }];
  return [{ below: null, tone: 'normal' }];
}

function collapseTone(tone: StatTone | null, max: number | null): StatTone | null {
  if (tone === null || max === null || max >= 4) return tone;
  if (max >= 2) return tone === 'very-low' ? 'low' : tone === 'very-high' ? 'high' : tone;
  if (max === 1) return tone === 'very-low' || tone === 'low' ? 'low' : 'normal';
  return 'normal';
}

/* ------------------------------------------------- the starting hands - */

const CLASS_RANKS = 'AKQJT98765432';

/** `AKs`, `AKo`, `AA` of two hole cards. */
export function handClassOf(cards: readonly string[]): string | null {
  const [a, b] = cards;
  if (!a || !b) return null;
  const ra = CLASS_RANKS.indexOf(a[0] ?? '');
  const rb = CLASS_RANKS.indexOf(b[0] ?? '');
  if (ra < 0 || rb < 0) return null;
  const [hi, lo] = ra <= rb ? [a, b] : [b, a];
  if (hi[0] === lo[0]) return `${hi[0]}${lo[0]}`;
  return `${hi[0]}${lo[0]}${a[1] === b[1] ? 's' : 'o'}`;
}

/** The 169 classes' rows (Reports' starting hands): a made-up strength gives the win rate and how often it is played. */
function handClassRows(definitions: readonly Definition[], totalHands: number, random: () => number): GroupRow[] {
  const rows: GroupRow[] = [];
  const perCombo = totalHands / 1326;
  for (let i = 0; i < 13; i += 1) {
    for (let j = 0; j < 13; j += 1) {
      const a = CLASS_RANKS[i] ?? '';
      const b = CLASS_RANKS[j] ?? '';
      const pair = i === j;
      const suited = i < j;
      const key = pair ? `${a}${b}` : suited ? `${a}${b}s` : `${b}${a}o`;
      const hi = 12 - Math.min(i, j);
      const lo = 12 - Math.max(i, j);
      const gap = Math.abs(i - j);
      const strength = pair
        ? Math.min(1, 0.62 + (hi / 12) * 0.42)
        : Math.max(0, Math.min(1, (hi * 1.6 + lo) / 30 + (suited ? 0.08 : 0) - Math.max(0, gap - 3) * 0.035));
      const combos = pair ? 6 : suited ? 4 : 12;
      const hands = Math.max(1, Math.round(perCombo * combos * (0.92 + random() * 0.16)));
      const bb100 = -38 + (pair ? 290 * strength ** 3 : 130 * strength ** 5) + (random() - 0.5) * 10;
      const vpip = Math.min(100, Math.max(2, 5 + 110 * strength ** 1.6));
      const pfr = Math.min(vpip, Math.max(0.5, vpip * (0.55 + strength * 0.4)));
      rows.push(groupRow(definitions, key, null, hands, { ...HERO_PROFILE, vpip, pfr }, bb100, random));
    }
  }
  return rows;
}

/* ---------------------------------------------------------- the analysis - */

interface AnalysisData {
  review: SessionReviewDto;
  sessions: ReviewSessionRow[];
  topLeaks: TopLeaksDto;
  examples: LeakExampleDto[];
}

/**
 * The analysis of the last finished session (yesterday's at Winamax) and
 * the leak finder's top three over the last 30 days: postflop spots, keys
 * `street|scenario|line|seat|taken|best` as `analysis_leaks` sums them.
 */
function analysisData(rows: readonly HandRow[], now: number, today: { startedAt: string; endedAt: string }): AnalysisData {
  const iso = (ms: number) => new Date(ms).toISOString();
  const day = 24 * 3600_000;
  const winamax = rows.filter((row) => row.site === 'winamax');
  const times = winamax.map((row) => Date.parse(row.playedAt ?? '')).sort((a, b) => a - b);
  // The listed hands are its last minutes; the session itself ran two hours and forty minutes.
  const ended = times[times.length - 1] ?? now - day + 3600_000;
  const started = Math.min(times[0] ?? ended, ended - (2 * 60 + 40) * 60_000);
  const handOf = (row: HandRow, grade: string | null, evLossBb: number | null): ReviewHandDto => ({
    handId: row.handKey,
    playedAt: row.playedAt,
    site: row.site,
    gameFormat: row.gameFormat,
    currency: row.currency,
    currencySymbol: row.currencySymbol,
    minorUnits: row.minorUnits,
    smallBlind: row.smallBlind,
    bigBlind: row.bigBlind,
    tableName: row.tableName,
    position: row.heroPosition,
    heroCards: row.heroCards,
    handClass: handClassOf(row.heroCards),
    board: row.board,
    potType: row.potType,
    potBb: row.bigBlind > 0 ? Math.round((row.totalPot / row.bigBlind) * 10) / 10 : null,
    net: row.heroNet,
    netBbMilli: row.heroNetBbMilli,
    evNetBbMilli: row.evNetBbMilli,
    grade,
    evLossBb,
  });
  const decision = (
    row: HandRow,
    street: string,
    action: string,
    best: string,
    grade: string,
    evLossBb: number,
    extra: Partial<ReviewDecision> = {},
  ): ReviewDecision => ({
    handId: row.handKey,
    ord: street === 'preflop' ? 1 : street === 'flop' ? 3 : street === 'turn' ? 5 : 7,
    actionIndex: street === 'preflop' ? 4 : street === 'flop' ? 10 : street === 'turn' ? 13 : 16,
    street,
    action,
    best,
    scenario: null,
    position: row.heroPosition,
    source: street === 'preflop' ? 'chart' : 'solver',
    grade,
    evLossBb,
    evLossPot: Math.round((evLossBb / Math.max(1, row.totalPot / row.bigBlind)) * 1000) / 1000,
    chosenFreq: null,
    ...extra,
  });
  const withBoard = winamax.filter((row) => row.board.length >= 4);
  const preflop = winamax.filter((row) => row.board.length < 3 && row.potType !== 'walk');
  const nth = (list: readonly HandRow[], index: number) => list[index % Math.max(1, list.length)] ?? winamax[0]!;
  const worst = [
    decision(nth(withBoard, 0), 'river', 'call', 'fold', 'blunder', 6.8),
    decision(nth(withBoard, 1), 'turn', 'bet', 'check', 'mistake', 3.9),
    decision(nth(withBoard, 2), 'flop', 'call', 'raise', 'mistake', 2.6),
    decision(nth(preflop, 0), 'preflop', 'call', 'fold', 'inaccurate', 0.9, { scenario: 'vs-3bet', chosenFreq: 0.02 }),
  ];
  const chartDeviations = [
    decision(nth(preflop, 0), 'preflop', 'call', 'fold', 'inaccurate', 0.9, { scenario: 'vs-3bet', chosenFreq: 0.02 }),
    decision(nth(preflop, 1), 'preflop', 'raise', 'fold', 'inaccurate', 0.6, { scenario: 'unopened', chosenFreq: 0 }),
    decision(nth(preflop, 2), 'preflop', 'fold', 'call', 'inaccurate', 0.4, { scenario: 'vs-open', chosenFreq: 0.03 }),
  ];
  const potsRows = [...winamax].sort((a, b) => b.totalPot - a.totalPot).slice(0, 5);
  const graded = new Map<string, { grade: string; evLossBb: number }>();
  for (const d of [...worst, ...chartDeviations]) {
    const was = graded.get(d.handId);
    if (!was || (d.evLossBb ?? 0) > was.evLossBb) graded.set(d.handId, { grade: d.grade ?? 'good', evLossBb: d.evLossBb ?? 0 });
  }
  const hands: Record<string, ReviewHandDto> = {};
  for (const row of potsRows) {
    const g = graded.get(row.handKey);
    hands[row.handKey] = handOf(row, g?.grade ?? 'good', g?.evLossBb ?? 0.1);
  }
  // The graded hands as their decisions tell them: the cards, the seat and the result fit what was done.
  const fit = (decisionOf: ReviewDecision, over: Partial<ReviewHandDto> & { netBb: number }) => {
    const row = winamax.find((r) => r.handKey === decisionOf.handId) ?? winamax[0]!;
    const g = graded.get(row.handKey);
    const { netBb, ...rest } = over;
    const hand = {
      ...handOf(row, g?.grade ?? 'good', g?.evLossBb ?? 0),
      ...rest,
      netBbMilli: Math.round(netBb * 1000),
      net: Math.round(netBb * row.bigBlind),
      evNetBbMilli: null,
    };
    hand.handClass = handClassOf(hand.heroCards);
    hands[row.handKey] = hand;
    decisionOf.position = hand.position;
  };
  fit(worst[0]!, { heroCards: ['Qh', 'Jh'], position: 'BB', potType: 'single-raised', potBb: 52.4, netBb: -24.6 });
  fit(worst[1]!, { heroCards: ['9c', '8c'], position: 'BTN', potType: 'single-raised', potBb: 30.4, netBb: -15.2 });
  fit(worst[2]!, { heroCards: ['Jd', 'Td'], position: 'HJ', potType: 'single-raised', potBb: 18.6, netBb: 8.5 });
  for (const d of [worst[3]!, chartDeviations[0]!]) {
    fit(d, { heroCards: ['Ks', '9d'], position: 'CO', potType: '3bet', potBb: 22.5, netBb: -7.5 });
  }
  fit(chartDeviations[1]!, { heroCards: ['Jh', '4h'], position: 'UTG', potType: 'single-raised', potBb: 6.5, netBb: -2.5, board: [] });
  fit(chartDeviations[2]!, { heroCards: ['Qd', 'Jd'], position: 'BB', potType: 'single-raised', potBb: 3.5, netBb: -1, board: [] });
  const review: SessionReviewDto = {
    gapMinutes: 30,
    session: {
      startedAt: iso(started),
      endedAt: iso(ended),
      finished: true,
      previousAt: iso(now - 3 * day),
      nextAt: today.startedAt,
      hands: 386,
      tables: 2,
      allInHands: 9,
      mixedUnitKind: false,
      mixedCurrency: false,
      cash: true,
      currency: 'EUR',
      currencySymbol: '€',
      currencyMinorUnits: 100,
      netBbMilli: 61_400,
      evNetBbMilli: 48_200,
      net: 1_535,
      evNet: 1_205,
    },
    ongoing: today,
    coverage: { hands: 386, analysed: 386, graded: 344, notAnalysed: 15 },
    worst,
    chartDeviations,
    pots: potsRows.map((row) => ({ handId: row.handKey, potBb: Math.round((row.totalPot / row.bigBlind) * 10) / 10 })),
    hands,
  };
  const sessions: ReviewSessionRow[] = [
    { startedAt: today.startedAt, endedAt: today.endedAt, hands: 412, tables: 3, netBbMilli: 84_200 },
    { startedAt: iso(started), endedAt: iso(ended), hands: 386, tables: 2, netBbMilli: 61_400 },
    { startedAt: iso(now - 3 * day - 2 * 3600_000), endedAt: iso(now - 3 * day), hands: 240, tables: 1, netBbMilli: -22_700 },
    { startedAt: iso(now - 4 * day - 3 * 3600_000), endedAt: iso(now - 4 * day), hands: 655, tables: 4, netBbMilli: 37_900 },
  ];

  // A spot's rows: the wrong turn and the right one (every decision counts towards how often the spot came up).
  const spot = (
    street: string,
    scenario: string,
    seat: string,
    taken: string,
    best: string,
    wrong: { decisions: number; mistakes: number; evLossBb: number },
    right: number,
  ) => {
    const key = (t: string) => `${street}|${scenario}||${seat}|${t}|${best}`;
    return [
      {
        key: key(taken),
        set: null,
        decisions: wrong.decisions,
        nonPerfect: wrong.decisions,
        mistakes: wrong.mistakes,
        evLossBb: wrong.evLossBb,
        evLossPot: wrong.evLossBb / 22,
        scoreSum: wrong.decisions * 52,
        scoreSq: wrong.decisions * 52 * 52 + wrong.decisions * 300,
      },
      {
        key: key(best),
        set: null,
        decisions: right,
        nonPerfect: 0,
        mistakes: 0,
        evLossBb: 0,
        evLossPot: 0,
        scoreSum: right * 96,
        scoreSq: right * 96 * 96 + right * 20,
      },
    ];
  };
  const sample = (scale: number, worse = 1) => [
    ...spot('river', 'caller-oop-vs-bet', 'BB', 'call', 'fold', { decisions: Math.round(58 * scale * worse), mistakes: Math.round(31 * scale * worse), evLossBb: 74.2 * scale * worse }, Math.round(96 * scale)),
    ...spot('flop', 'pfr-oop-first', 'SB', 'bet', 'check', { decisions: Math.round(83 * scale * worse), mistakes: Math.round(22 * scale * worse), evLossBb: 41.5 * scale * worse }, Math.round(120 * scale)),
    ...spot('turn', 'caller-ip-vs-bet', 'BTN', 'fold', 'call', { decisions: Math.round(47 * scale * worse), mistakes: Math.round(19 * scale * worse), evLossBb: 33.8 * scale * worse }, Math.round(88 * scale)),
    ...spot('flop', 'caller-ip-vs-bet', 'CO', 'call', 'raise', { decisions: Math.round(12 * scale * worse), mistakes: Math.round(2 * scale * worse), evLossBb: 3.1 * scale * worse }, Math.round(70 * scale)),
  ];
  const leakRows = sample(1);
  const topLeaks: TopLeaksDto = {
    last: iso(now - 60_000).slice(0, 10),
    current: { from: iso(now - 30 * day).slice(0, 10), to: iso(now).slice(0, 10) },
    prior: { from: iso(now - 60 * day).slice(0, 10), to: iso(now - 30 * day).slice(0, 10) },
    sample: { hands: 9_840, graded: 8_920, rows: leakRows },
    now: { hands: 9_840, graded: 8_920, rows: leakRows },
    // The 30 days before: the same spots, gone wrong more often (the river calls most).
    was: { hands: 10_310, graded: 9_350, rows: sample(1.05, 1.6) },
  };
  const examples: LeakExampleDto[] = withBoard.slice(0, 6).map((row, index) => ({
    handId: row.handKey,
    ord: 7,
    actionIndex: 16,
    playedAt: row.playedAt,
    site: row.site,
    currency: row.currency,
    currencySymbol: row.currencySymbol,
    minorUnits: row.minorUnits,
    smallBlind: row.smallBlind,
    bigBlind: row.bigBlind,
    heroCards: row.heroCards,
    handClass: handClassOf(row.heroCards),
    spotKey: leakRows[0]!.key,
    grade: index === 0 ? 'blunder' : 'mistake',
    evLossBb: Math.round((6.8 - index * 0.9) * 10) / 10,
    evLossPot: Math.round(((6.8 - index * 0.9) / 24) * 1000) / 1000,
  }));
  return { review, sessions, topLeaks, examples };
}

/* ------------------------------------------------------------- the scenes - */

/** What a command answers in each scene: the first-run, after the import, the HUD at tables. */
export type SceneName = 'firstRun' | 'imported' | 'daily' | 'hud' | 'hudPermission';

export interface Scene {
  settings: Settings;
  account: AccountStatus;
  watcher: WatchStatus;
  store: StoreStatus;
  sync: SyncStatus | null;
  today: { session: Session | null };
  hud: HudStatus;
}

export interface MockData {
  hero: string;
  names: string[];
  scenes: Record<SceneName, Scene>;
  definitions: Definition[];
  coreInfo: CoreInfo;
  appInfo: AppInfo;
  entitlements: EntitlementsStatus;
  statsStatus: StatsStatus;
  discovery: Discovery;
  pickFolder: string;
  rooms: RoomChoice[];
  quarantine: QuarantineSummary;
  quarantineEntries: QuarantineList;
  customStats: CustomList;
  rows: HandRow[];
  facets: HandFacets;
  phf: Record<string, PhfHand>;
  annotations: Record<string, { note: string | null; tags: string[] }>;
  savedFilters: SavedFilter[];
  report: Report;
  /** The report over PokerStars only: one currency, so the money view has numbers. */
  reportStars: Report;
  reportSavedFilters: SavedFilter[];
  breakdowns: Breakdowns;
  breakdownsStars: Breakdowns;
  analysis: AnalysisData;
  players: PlayerRow[];
  playerSites: { value: string; name: string }[];
  playerLabels: FacetCount[];
  profiles: Record<string, PlayerProfile>;
  hudPolicy: HudPolicy;
  hudEditor: HudEditorState;
  popup: HudPopup;
}

export function buildMockData(now = Date.now()): MockData {
  const random = seeded(4242);
  const names = opponentNames(40);
  const definitions: Definition[] = readJson<{ stats: StatDefinition[] }>('config/stats/standard.json').stats.map(
    (def) => ({ ...def, custom: false }),
  );
  const sites = readJson<{ version: number; sites: SiteEntry[] }>('config/sites.json');
  const presetsFile = readJson<{ defaults: Record<GameFormat, string>; presets: HudPreset[] }>('config/hud/presets.json');
  const iso = (ms: number) => new Date(ms).toISOString();

  /* The hand the replayer opens, and the list. */
  const handAt = new Date(now - 4 * 60_000);
  const { phf, row: scriptedRow } = scriptedHand(names.slice(0, 5), handAt);
  const rows = handRows(random, now, scriptedRow);
  const STORE_HANDS = 48_210;
  const facets = facetsOf(rows, STORE_HANDS);

  /* Today's session: PokerStars, three tables, still going. */
  const sessionStart = now - (2 * 60 + 14) * 60_000;
  const sessionHands = 412;
  const sessionRows = rows.filter((r) => Date.parse(r.playedAt ?? '') >= sessionStart);
  const biggestPots = [...sessionRows].sort((a, b) => b.totalPot - a.totalPot).slice(0, 5);
  const session: Session = {
    startedAt: iso(sessionStart),
    endedAt: iso(now - 60_000),
    current: true,
    gapMinutes: 30,
    hands: sessionHands,
    tables: 3,
    net: 4210,
    netBbMilli: 84_200,
    units: { mixedKind: false, mixedCurrency: false, currency: 'USD', symbol: '$', minorUnits: 100 },
    stats: statsFor(definitions, { ...HERO_PROFILE, bb_per_100: 84.2 / 4.12, allin_ev_bb_per_100: 14.9 }, sessionHands, {
      hero: true,
      minorUnits: 100,
      random,
    }),
    biggestPots,
  };

  /* The folders and the import. */
  const backfill = {
    bytesDone: 431 * 1024 * 1024,
    bytesTotal: 688 * 1024 * 1024,
    filesDone: 742,
    filesTotal: 1204,
    hands: 31_540,
    startedAt: now - 6 * 60_000,
    secondsLeft: 340,
  };
  const source = (id: number, over: Partial<WatchSource> & Pick<WatchSource, 'path'>): WatchSource => ({
    id,
    enabled: true,
    site: null,
    siteName: null,
    siteOverride: null,
    state: 'watching',
    error: null,
    recursive: true,
    pollOnly: false,
    files: 0,
    hands: 0,
    handsToday: 0,
    quarantined: 0,
    fileErrors: 0,
    pending: 0,
    backfill: null,
    lastImportAt: null,
    ...over,
  });
  const sources: WatchSource[] = [
    source(1, {
      path: FOLDERS.pokerstars,
      site: 'pokerstars',
      siteName: 'PokerStars',
      files: 1204,
      hands: 31_540,
      handsToday: 412,
      quarantined: 3,
      pending: 3,
      backfill,
      lastImportAt: now - 20_000,
    }),
    source(2, {
      path: FOLDERS.weplay,
      site: 'weplay',
      siteName: 'WePlay',
      files: 86,
      hands: 5_960,
      lastImportAt: now - 3 * 24 * 3600_000,
    }),
    source(3, {
      path: FOLDERS.winamax,
      files: 540,
      hands: 10_710,
      lastImportAt: now - 26 * 3600_000,
    }),
  ];
  const watching: WatchStatus = { running: true, paused: false, threads: 2, threadsAllowed: 2, error: null, sources };
  const emptyWatcher: WatchStatus = { ...watching, sources: [] };
  const storeImported: StoreStatus = {
    path: `${HOME}/Library/Application Support/app.rail.desktop/rail.db`,
    error: null,
    schemaVersion: 14,
    hands: STORE_HANDS,
    handsToday: sessionHands,
    files: 1830,
    filesWithErrors: 0,
    sources: 3,
    quarantined: 3,
    unsupported: 0,
    outbox: 2_800,
  };
  const storeEmpty: StoreStatus = { ...storeImported, hands: 0, handsToday: 0, files: 0, sources: 0, quarantined: 0, outbox: 0 };

  /* The account and sync. */
  const signedIn: AccountStatus = {
    state: 'signedIn',
    email: ACCOUNTS.demo.email,
    userId: '00000000-0000-4000-8000-00000000d3e0',
    online: true,
    notice: null,
  };
  const syncBase: SyncStatus = {
    phase: { state: 'syncing' },
    paused: false,
    outbox: 2_800,
    live: 12,
    retrying: 0,
    sent: 1_200,
    total: 4_000,
    rejected: [],
    pulled: 0,
    pullSkipped: 0,
    lastSyncAt: now - 15_000,
    handsPerSecond: 85,
    bytesPerSecond: 1024 * 1024,
    cap: 1024 * 1024,
    capNow: 1024 * 1024,
    tablesOpen: false,
  };
  const syncSignedOut: SyncStatus = { ...syncBase, phase: { state: 'signedOut' }, outbox: 0, sent: 0, total: 0, handsPerSecond: null, bytesPerSecond: null, capNow: null, lastSyncAt: null };

  /* The HUD and the rooms' policies. */
  const policyRooms: RoomPolicy[] = sites.sites.map((site) => ({
    id: site.id,
    name: site.name,
    kind: site.kind,
    allowed: site.hud.allowed,
    permitted: site.hud.allowed === true && site.kind === 'room',
    source: site.hud.source,
    checkedAt: site.hud.checkedAt,
    notes: site.hud.notes ?? '',
    restrictions: site.hud.restrictions ?? null,
    stricterThanShipped: false,
  }));
  const hudRooms: HudRoom[] = policyRooms
    .filter((room) => room.permitted && room.restrictions)
    .map((room) => ({ id: room.id, name: room.name, restrictions: room.restrictions as HudRestrictions }));
  for (const room of hudRooms) RULES[room.id] = room.restrictions;
  const hudPolicy: HudPolicy = {
    rooms: policyRooms,
    remote: true,
    url: 'https://rail.test/hud-policy.json',
    fetchedAt: Math.floor((now - 2 * 24 * 3600_000) / 1000),
    lastCheck: { at: Math.floor((now - 3 * 3600_000) / 1000), outcome: { kind: 'current' } },
    notes: [],
  };
  const hudIdle: HudStatus = {
    phase: 'running',
    error: null,
    tablesOpen: 0,
    tablesWaiting: 0,
    tables: [],
    refused: [],
    remotePolicy: true,
    permissionNeeded: null,
    permissionDeferred: null,
  };
  const hudTables: HudStatus = {
    ...hudIdle,
    tablesOpen: 3,
    tablesWaiting: 1,
    tables: [
      { site: 'pokerstars', window: 4101, table: 'Vega IV', waiting: false },
      { site: 'pokerstars', window: 4102, table: 'Altair II', waiting: false },
      { site: 'winamax', window: 4210, table: 'Lyon 12', waiting: true },
    ],
    refused: [
      { site: 'ggpoker', window: 5120, table: 'NLH 0.25/0.50 · Table 7', reason: 'prohibited' },
      { site: 'weplay', window: 5301, table: 'NLH Daily 7', reason: 'unknown' },
    ],
  };
  const hudPermission: HudStatus = { ...hudIdle, permissionNeeded: 'accessibility' };

  const hudStats: HudStat[] = definitions.map((def) => ({
    id: def.id,
    label: def.label,
    name: def.name,
    description: def.description,
    group: def.group,
    unit: def.format.unit,
    decimals: def.format.decimals,
    minSample: def.sample.min,
    bands: def.bands,
    hud: def.hud,
    custom: false,
    cardSplit: false,
    heroOnly: def.players === 'hero',
    money: def.format.unit === 'money',
  }));
  const checks: Record<string, HudCheck> = {};
  for (const preset of presetsFile.presets) {
    const rooms: Record<string, HudCheck['problems']> = {};
    for (const room of hudRooms) {
      const problems = checkForRoom(preset.design, room.restrictions, hudStats);
      if (problems.length > 0) rooms[room.id] = problems;
    }
    checks[preset.id] = { problems: [], rooms };
  }
  const formats: GameFormat[] = ['cash', 'mtt', 'spin'];
  const hudEditor: HudEditorState = {
    presets: presetsFile.presets,
    defaults: presetsFile.defaults,
    designs: [],
    assignments: [],
    resolved: hudRooms.flatMap((room) =>
      [null, 2, 3, 4, 5, 6, 7, 8, 9, 10].flatMap((size) =>
        formats.map((format) => ({ site: room.id, size, format, layout: presetsFile.defaults[format], assigned: false })),
      ),
    ),
    rooms: hudRooms,
    stats: hudStats,
    checks,
    positions: [{ site: 'pokerstars', size: 6, panels: 1 }],
    roomSettings: hudRooms.map((room) => ({ site: room.id, preferredSeat: null })),
    limits: { maxCells: 12, maxColumns: 6, maxDecimals: 2, maxPopupSections: 8, maxPopupStats: 40 },
  };

  /* Players. */
  const playerSites = [
    { value: 'pokerstars', name: 'PokerStars' },
    { value: 'winamax', name: 'Winamax' },
    { value: 'weplay', name: 'WePlay' },
  ];
  const typeNames = Object.keys(TYPES);
  const playerType = (name: string) => typeNames[[...name].reduce((sum, c) => sum + c.charCodeAt(0), 0) % typeNames.length] as string;
  const colours: PlayerRow['colour'][] = ['red', null, 'green', null, null, 'yellow', null, 'blue', null, null];
  const players: PlayerRow[] = names.map((name, index) => {
    const site = index < 26 ? playerSites[0] : index < 36 ? playerSites[1] : playerSites[2];
    const hands = Math.max(60, Math.round(2400 / (1 + index * 0.35)) + between(random, 0, 80));
    const type = playerType(name);
    const net = type === 'fish' ? between(random, 8, 40) : between(random, -12, 9);
    return {
      site: site!.value,
      siteName: site!.name,
      player: name,
      hands,
      netBbMilli: Math.round(net * hands * 10),
      moneyHands: hands,
      firstPlayedAt: iso(now - between(random, 20, 200) * 24 * 3600_000),
      lastPlayedAt: iso(index < 6 ? now - between(random, 1, 30) * 60_000 : now - between(random, 1, 20) * 24 * 3600_000),
      colour: colours[index % colours.length] ?? null,
      labels: index === 1 ? ['reg', '3-bets light'] : index === 4 ? ['fish'] : index === 2 ? ['reg'] : [],
      hasNote: index === 1 || index === 4,
    };
  });
  const notesOf = (row: PlayerRow): PlayerNotes => ({
    colour: row.colour,
    labels: row.labels,
    note:
      row.labels.includes('3-bets light')
        ? 'Three-bets the button wide from the HJ. Folds the turn when called twice.'
        : row.hasNote
          ? 'Calls too much on the flop, gives up on the turn.'
          : '',
  });
  const profiles: Record<string, PlayerProfile> = {};
  for (const row of players) {
    const profile = TYPES[playerType(row.player)] ?? TYPES.reg!;
    const stats = statsFor(definitions, profile, row.hands, { hero: false, minorUnits: 100, random });
    const stake = STAKES[row.site as RoomKey];
    profiles[`${row.site}:${row.player}`] = {
      site: row.site,
      siteName: row.siteName,
      player: row.player,
      seen: {
        hands: row.hands,
        firstPlayedAt: row.firstPlayedAt,
        lastPlayedAt: row.lastPlayedAt,
        cash: { hands: row.hands, moneyHands: row.hands, netBbMilli: row.netBbMilli ?? 0 },
        chips: { hands: 0, moneyHands: 0, netBbMilli: 0 },
      },
      notes: notesOf(row),
      mixedKind: false,
      stats,
      columns: BREAKDOWN_COLUMNS,
      byPosition: POSITIONS.map((position) =>
        groupRow(definitions, position, null, Math.round(row.hands / 6), profile, profile.bb_per_100 ?? 0, random),
      ),
      byStake: [
        groupRow(definitions, `${stake.currency}:${stake.bb}`, null, row.hands, profile, profile.bb_per_100 ?? 0, random),
      ],
      bySize: [groupRow(definitions, '6max', null, row.hands, profile, profile.bb_per_100 ?? 0, random)],
      byFormat: [groupRow(definitions, 'cash', null, row.hands, profile, profile.bb_per_100 ?? 0, random)],
      stakes: [
        {
          key: `${stake.currency}:${stake.bb}`,
          currency: stake.currency,
          currencySymbol: stake.symbol,
          minorUnits: 100,
          smallBlind: stake.sb,
          bigBlind: stake.bb,
        },
      ],
      lastPlayedAt: row.lastPlayedAt,
    };
  }

  /* Reports over the whole library. */
  const BUCKETS = 120;
  let cum = 0;
  let cumSd = 0;
  let cumEv = 0;
  const buckets = Array.from({ length: BUCKETS }, (_, i) => {
    const hands = Math.round(STORE_HANDS / BUCKETS);
    const drift = 6.4 * (hands / 100) * 1000;
    const swing = (random() - 0.5) * 140_000;
    cum += drift + swing;
    cumSd += drift * 1.9 + swing * 0.8;
    cumEv += drift * 0.78 + swing * 0.35;
    const at = now - (BUCKETS - i) * 9 * 3600_000;
    return {
      bucket: i,
      hands,
      firstPlayedAt: iso(at),
      lastPlayedAt: iso(at + 8 * 3600_000),
      cumHands: hands * (i + 1),
      cumNetBbMilli: Math.round(cum),
      cumSdBbMilli: Math.round(cumSd),
      cumNsdBbMilli: Math.round(cum - cumSd),
      cumEvBbMilli: Math.round(cumEv),
      cumNet: null,
      moneyHands: hands,
      cumMoneyHands: hands * (i + 1),
    };
  });
  const finalNet = buckets[buckets.length - 1]?.cumNetBbMilli ?? 0;
  const position = (key: string, share: number, bb100: number) =>
    groupRow(definitions, key, null, Math.round(STORE_HANDS * share), HERO_PROFILE, bb100, random);
  const report: Report = {
    units: { mixedKind: false, mixedCurrency: true, currency: null, symbol: null, minorUnits: null },
    summary: {
      hands: STORE_HANDS,
      moneyHands: STORE_HANDS,
      net: null,
      netBbMilli: finalNet,
      evNetBbMilli: buckets[buckets.length - 1]?.cumEvBbMilli ?? 0,
      stats: statsFor(
        definitions,
        {
          ...HERO_PROFILE,
          bb_per_100: finalNet / (10 * STORE_HANDS),
          allin_ev_bb_per_100: (buckets[buckets.length - 1]?.cumEvBbMilli ?? 0) / (10 * STORE_HANDS),
        },
        STORE_HANDS,
        { hero: true, minorUnits: null, random },
      ),
      ids: definitions.map((d) => d.id),
    },
    graph: {
      hands: STORE_HANDS,
      buckets,
      allInEv: { allInHands: 1_184, pending: 0 },
      mixedUnitKind: false,
      mixedCurrency: true,
      moneyHands: STORE_HANDS,
    },
    columns: BREAKDOWN_COLUMNS,
    byPosition: [
      position('UTG', 0.165, 4.1),
      position('HJ', 0.166, 7.9),
      position('CO', 0.167, 14.6),
      position('BTN', 0.168, 31.2),
      position('SB', 0.167, -14.8),
      position('BB', 0.167, -36.5),
    ],
    byStake: [
      groupRow(definitions, 'USD:50', null, 31_540, HERO_PROFILE, 7.1, random, 50),
      groupRow(definitions, 'EUR:25', null, 10_710, HERO_PROFILE, 5.8, random, 25),
      groupRow(definitions, 'USD:100', null, 5_960, HERO_PROFILE, 4.3, random, 100),
    ],
    bySite: [
      groupRow(definitions, 'pokerstars', 'PokerStars', 31_540, HERO_PROFILE, 7.1, random),
      groupRow(definitions, 'winamax', 'Winamax', 10_710, HERO_PROFILE, 5.8, random),
      groupRow(definitions, 'weplay', 'WePlay', 5_960, HERO_PROFILE, 4.3, random),
    ],
    bySize: [groupRow(definitions, '6max', null, STORE_HANDS, HERO_PROFILE, 6.4, random)],
    byFormat: [groupRow(definitions, 'cash', null, STORE_HANDS, HERO_PROFILE, 6.4, random)],
  };
  /** The breakdowns by situation over `total` hands (the library's shares). */
  const breakdownsOf = (total: number): Breakdowns => ({
    columns: BREAKDOWN_COLUMNS,
    potType: [
      groupRow(definitions, 'walk', null, Math.round((2_130 * total) / STORE_HANDS), HERO_PROFILE, 75.0, random),
      groupRow(definitions, 'limped', null, Math.round((3_210 * total) / STORE_HANDS), HERO_PROFILE, 2.2, random),
      groupRow(definitions, 'single-raised', null, Math.round((33_480 * total) / STORE_HANDS), HERO_PROFILE, 4.9, random),
      groupRow(definitions, '3bet', null, Math.round((7_920 * total) / STORE_HANDS), HERO_PROFILE, 9.8, random),
      groupRow(definitions, '4bet+', null, Math.round((1_470 * total) / STORE_HANDS), HERO_PROFILE, 21.4, random),
    ],
    stack: [
      groupRow(definitions, '40-70', null, Math.round((6_120 * total) / STORE_HANDS), HERO_PROFILE, 3.3, random),
      groupRow(definitions, '70-100', null, Math.round((35_840 * total) / STORE_HANDS), HERO_PROFILE, 6.9, random),
      groupRow(definitions, '100-150', null, Math.round((6_250 * total) / STORE_HANDS), HERO_PROFILE, 7.4, random),
    ],
    handClass: handClassRows(definitions, total, random),
    players: [
      groupRow(definitions, '2', null, Math.round((1_910 * total) / STORE_HANDS), HERO_PROFILE, 12.0, random),
      groupRow(definitions, '5', null, Math.round((9_340 * total) / STORE_HANDS), HERO_PROFILE, 7.5, random),
      groupRow(definitions, '6', null, Math.round((36_960 * total) / STORE_HANDS), HERO_PROFILE, 6.0, random),
    ],
    street: [
      groupRow(definitions, 'preflop', null, Math.round((33_360 * total) / STORE_HANDS), HERO_PROFILE, -6.1, random),
      groupRow(definitions, 'flop', null, Math.round((6_890 * total) / STORE_HANDS), HERO_PROFILE, 18.0, random),
      groupRow(definitions, 'turn', null, Math.round((3_470 * total) / STORE_HANDS), HERO_PROFILE, 22.5, random),
      groupRow(definitions, 'river', null, Math.round((4_490 * total) / STORE_HANDS), HERO_PROFILE, 41.0, random),
    ],
  });
  const breakdowns = breakdownsOf(STORE_HANDS);

  /* Reports over PokerStars alone ($0.25/$0.50): money adds up. */
  const STARS_HANDS = 31_540;
  const share = STARS_HANDS / STORE_HANDS;
  const cents = (milli: number) => Math.round((milli / 1000) * 50);
  const starsBuckets = buckets.map((b) => {
    const cum = Math.round(b.cumNetBbMilli * share * 1.1);
    const sd = Math.round(b.cumSdBbMilli * share * 1.1);
    const ev = Math.round(b.cumEvBbMilli * share * 1.1);
    return {
      ...b,
      hands: Math.round(b.hands * share),
      cumHands: Math.round(b.cumHands * share),
      moneyHands: Math.round(b.moneyHands * share),
      cumMoneyHands: Math.round(b.cumMoneyHands * share),
      cumNetBbMilli: cum,
      cumSdBbMilli: sd,
      cumNsdBbMilli: cum - sd,
      cumEvBbMilli: ev,
      cumNet: cents(cum),
      cumSdNet: cents(sd),
      cumNsdNet: cents(cum - sd),
      cumEvNet: cents(ev),
    };
  });
  const starsLast = starsBuckets[starsBuckets.length - 1];
  const starsNet = starsLast?.cumNetBbMilli ?? 0;
  const starsEv = starsLast?.cumEvBbMilli ?? 0;
  const reportStars: Report = {
    ...report,
    units: { mixedKind: false, mixedCurrency: false, currency: 'USD', symbol: '$', minorUnits: 100 },
    summary: {
      hands: STARS_HANDS,
      moneyHands: STARS_HANDS,
      net: cents(starsNet),
      netBbMilli: starsNet,
      evNetBbMilli: starsEv,
      stats: statsFor(
        definitions,
        { ...HERO_PROFILE, bb_per_100: starsNet / (10 * STARS_HANDS), allin_ev_bb_per_100: starsEv / (10 * STARS_HANDS) },
        STARS_HANDS,
        { hero: true, minorUnits: 100, random },
      ),
      ids: definitions.map((d) => d.id),
    },
    graph: {
      hands: STARS_HANDS,
      buckets: starsBuckets,
      allInEv: { allInHands: 772, pending: 0 },
      mixedUnitKind: false,
      mixedCurrency: false,
      moneyHands: STARS_HANDS,
    },
    byPosition: [
      groupRow(definitions, 'UTG', null, Math.round(STARS_HANDS * 0.165), HERO_PROFILE, 4.8, random, 50),
      groupRow(definitions, 'HJ', null, Math.round(STARS_HANDS * 0.166), HERO_PROFILE, 9.1, random, 50),
      groupRow(definitions, 'CO', null, Math.round(STARS_HANDS * 0.167), HERO_PROFILE, 16.2, random, 50),
      groupRow(definitions, 'BTN', null, Math.round(STARS_HANDS * 0.168), HERO_PROFILE, 33.5, random, 50),
      groupRow(definitions, 'SB', null, Math.round(STARS_HANDS * 0.167), HERO_PROFILE, -13.9, random, 50),
      groupRow(definitions, 'BB', null, Math.round(STARS_HANDS * 0.167), HERO_PROFILE, -34.2, random, 50),
    ],
    byStake: [groupRow(definitions, 'USD:50', null, STARS_HANDS, HERO_PROFILE, 7.1, random, 50)],
    bySite: [groupRow(definitions, 'pokerstars', 'PokerStars', STARS_HANDS, HERO_PROFILE, 7.1, random)],
  };
  const breakdownsStars = breakdownsOf(STARS_HANDS);
  const analysis = analysisData(rows, now, { startedAt: session.startedAt, endedAt: session.endedAt });

  /* The HUD popup: a regular at a Winamax table. */
  const popupPlayer = players.find((p) => p.site === 'winamax' && p.labels.length === 0) ?? players[30]!;
  const winamax = RULES.winamax ?? null;
  const cash = presetsFile.presets.find((p) => p.id === 'cash')!;
  const popupMax = Math.min(winamax?.maxColourThresholds ?? Infinity, cash.design.maxColourThresholds ?? Infinity);
  const max = Number.isFinite(popupMax) ? popupMax : null;
  const popupIds = cash.design.popup.flatMap((section) =>
    section.stats.filter((id) => {
      const def = definitions.find((d) => d.id === id);
      return def !== undefined && def.players === 'any' && def.format.unit !== 'money';
    }),
  );
  const popupProfile = TYPES.lag!;
  // The room counts only hands played together (`ownHandsOnly`): the sample is those.
  const popupHands = 486;
  const allPopupStats = statsFor(definitions, popupProfile, popupHands, { hero: false, minorUnits: 100, random });
  const popupStats = popupIds.map((id) => {
    const shown = allPopupStats[definitions.findIndex((d) => d.id === id)] ?? NONE;
    return { ...shown, tone: collapseTone(shown.tone, max) };
  });
  const popupRow = { ...popupPlayer, colour: 'orange' as const, labels: ['reg'], hasNote: true };
  const popup: HudPopup = {
    site: 'winamax',
    siteName: 'Winamax',
    storeSite: 'winamax',
    table: 'Lyon 12',
    player: popupRow.player,
    hero: false,
    opaque: false,
    rules: { ownHandsOnly: true, colourThresholds: winamax?.maxColourThresholds ?? null, byPosition: false, words: true },
    hands: popupHands,
    ids: popupIds,
    stats: popupStats,
    legend: popupIds
      .map((id) => definitions.find((d) => d.id === id))
      .filter((def): def is Definition => def !== undefined && def.bands.length > 0)
      .map((def) => ({ id: def.id, bands: collapse(def.bands, max) })),
    together: {
      hands: popupHands,
      firstPlayedAt: popupRow.firstPlayedAt,
      lastPlayedAt: iso(now - 90_000),
      cash: { hands: popupHands, moneyHands: popupHands, netBbMilli: -21_400 },
      chips: { hands: 0, moneyHands: 0, netBbMilli: 0 },
    },
    notes: { colour: 'orange', labels: ['reg'], note: 'Opens wide on the button, folds to a 3-bet out of position.' },
    columns: BREAKDOWN_COLUMNS,
    byPosition: null,
    sections: cash.design.popup
      .map((section) => ({
        group: section.group ?? null,
        title: section.title ?? null,
        ids: section.stats.filter((id) => popupIds.includes(id)),
      }))
      .filter((section) => section.ids.length > 0),
  };
  const profileOfPopup = profiles[`${popupRow.site}:${popupRow.player}`];
  if (profileOfPopup) profileOfPopup.notes = popup.notes ?? profileOfPopup.notes;

  /* The settings, per scene. */
  const settings: Settings = { version: 1, theme: 'dark', density: 'comfortable', locale: 'en', startAtLogin: true, firstRunDone: true };
  const imported: Scene = {
    settings,
    account: signedIn,
    watcher: watching,
    store: storeImported,
    sync: syncBase,
    today: { session },
    hud: hudIdle,
  };

  const parsers = [
    'pokerstars', 'pokerstars888', 'ggpoker', 'winamax', 'partypoker', 'ipoker', 'acrwpn', 'coinpoker', 'unibet',
    'chico', 'ignition', 'weplay', 'pokerbros', 'microgaming', 'fulltilt', 'ongame', 'entraction', 'runitonce',
    'standard',
  ];
  return {
    hero: HERO,
    names,
    scenes: {
      firstRun: {
        settings: { ...settings, firstRunDone: false, startAtLogin: false },
        account: { state: 'signedOut', notice: null },
        watcher: emptyWatcher,
        store: storeEmpty,
        sync: syncSignedOut,
        today: { session: null },
        hud: hudIdle,
      },
      imported,
      // A day of use: the old hands are in, sync is up to date, the analysis has run.
      daily: {
        ...imported,
        watcher: { ...watching, sources: sources.map((source) => ({ ...source, backfill: null, pending: 0 })) },
        store: { ...storeImported, outbox: 0 },
        sync: { ...syncBase, phase: { state: 'upToDate' }, outbox: 0, sent: 0, total: 0, handsPerSecond: null, bytesPerSecond: null, capNow: null },
      },
      hud: { ...imported, sync: { ...syncBase, phase: { state: 'upToDate' }, outbox: 0, sent: 0, total: 0, tablesOpen: true }, hud: hudTables },
      hudPermission: { ...imported, hud: hudPermission },
    },
    definitions,
    coreInfo: {
      coreVersion: '0.14.0',
      phfSchema: 'phf/1',
      parsers,
      configVersion: sites.version,
      sites: sites.sites.length,
      configError: null,
    },
    appInfo: {
      version: '0.14.0',
      identifier: 'app.rail.desktop',
      logDir: `${HOME}/Library/Logs/app.rail.desktop`,
      dataDir: `${HOME}/Library/Application Support/app.rail.desktop`,
      settingsFile: `${HOME}/Library/Application Support/app.rail.desktop/settings.json`,
      debug: false,
    },
    entitlements: {
      effective: {
        plan: 'open',
        reason: 'notEnforced',
        enforcement: 'off',
        features: { desktopSync: true, hud: true, reportsFull: true, analysis: true, learn: true },
        proUntilMs: null,
        checkedAtMs: now - 3600_000,
      },
      check: { attemptedAtMs: now - 3600_000, succeededAtMs: now - 3600_000, failing: false },
      handsStored: null,
      handCap: null,
      serverReason: null,
      offlineGraceDays: 14,
      upgradeUrl: 'https://rail.test/settings/plan',
    },
    statsStatus: {
      activity: 'idle',
      rebuildDone: null,
      rebuildTotal: null,
      rebuildJob: null,
      rebuildFills: false,
      evRecomputeDone: null,
      evRecomputeTotal: null,
      evPending: 0,
      playersUnindexed: 0,
      evComputed: 1_184,
      evMillis: 2_310,
      lastError: null,
    },
    discovery: {
      os: 'macos',
      folders: [
        {
          site: 'pokerstars',
          name: 'PokerStars',
          path: FOLDERS.pokerstars,
          files: 1204,
          complete: true,
          newestMs: now - 20 * 3600_000,
          verified: false,
          sampleLooked: null,
          sampleClaimed: null,
          watched: false,
        },
        {
          site: 'weplay',
          name: 'WePlay',
          path: FOLDERS.weplay,
          files: 86,
          complete: true,
          newestMs: now - 3 * 24 * 3600_000,
          verified: true,
          sampleLooked: null,
          sampleClaimed: null,
          watched: false,
        },
      ],
      rooms: [
        { site: 'pokerstars', name: 'PokerStars', verified: false },
        { site: 'weplay', name: 'WePlay', verified: true },
      ],
    },
    pickFolder: FOLDERS.winamax,
    rooms: sites.sites
      .filter((site) => site.parser)
      .map((site) => ({ parser: site.parser as string, name: site.name })),
    quarantine: {
      reasons: [{ reason: 'incomplete-hand', count: 3 }],
      total: 3,
      retryable: { hands: 0, files: 0 },
    },
    quarantineEntries: { entries: [], truncated: false },
    customStats: {
      stats: [],
      fields: [],
      shipped: definitions.map((d) => d.id),
      previewHands: 2000,
    },
    rows,
    facets,
    phf: { [phf.meta.handKey]: phf },
    annotations: Object.fromEntries(
      rows
        .filter((row) => row.hasNote || row.tags.length > 0)
        .map((row) => [
          row.handKey,
          {
            note: row.hasNote
              ? row.handKey === phf.meta.handKey
                ? 'Value-bet the river? Checked back - a pair of Queens calls a small bet.'
                : 'Called down light; their river bets were thin before.'
              : null,
            tags: row.tags,
          },
        ]),
    ),
    savedFilters: [
      { id: 1, name: '3-bet pots on the button', filter: JSON.stringify({ positions: ['BTN'], potTypes: ['3bet'] }) },
      { id: 2, name: 'Big pots lost', filter: JSON.stringify({ results: ['lost'] }) },
    ],
    report,
    reportStars,
    reportSavedFilters: [{ id: 3, name: 'PokerStars only', filter: JSON.stringify({ sites: ['pokerstars'] }) }],
    breakdowns,
    breakdownsStars,
    analysis,
    players,
    playerSites,
    playerLabels: [
      { value: 'reg', count: 2 },
      { value: '3-bets light', count: 1 },
      { value: 'fish', count: 1 },
    ],
    profiles,
    hudPolicy,
    hudEditor,
    popup,
  };
}

/** Every made-up player name the mock serves (the name guard's `allowNames`). */
export function mockNames(data: MockData): string[] {
  return [data.hero, ...data.names];
}

