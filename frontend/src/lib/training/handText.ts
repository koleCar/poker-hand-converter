/**
 * A trainer spot as a real hand: a short script (who does what, in big
 * blinds) written out as standard hand-history text and read back by the same
 * parser an upload goes through (`parseStandardHand`).
 *
 * Going through text rather than building a `PhfHand` by hand is the point:
 * the spot the trainer grades is then a hand like any other, so the analysis
 * that grades it (`analyzeHand`), the replayer that draws it and the stats
 * engine underneath both read exactly what they read for an imported hand.
 * There is no second, trainer-shaped path through the grading to keep in step.
 *
 * Six-max by default, nine-max for the full-ring chart sets (`seats`, A2c),
 * $0.5/$1 (one big blind is one dollar, so every bb amount is a dollar
 * amount), seat 1 on the button, every stack the same. Money is counted in
 * cents so a 2.5bb open and a 33% bet never drift.
 */

import { parseStandardHand } from "../phf/serialize";
import type { PhfAction, PhfHand } from "../phf/types";

export const SCRIPT_POSITIONS = ["UTG", "HJ", "CO", "BTN", "SB", "BB"] as const;
/** The full-ring table, in preflop order (the 9-max chart sets' seats). */
export const NINE_SCRIPT_POSITIONS = ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB", "BB"] as const;
export type ScriptPosition = (typeof NINE_SCRIPT_POSITIONS)[number];

/** The script's table, in preflop order. */
function seatsOf(script: Pick<HandScript, "seats">): readonly ScriptPosition[] {
  return script.seats ?? SCRIPT_POSITIONS;
}

/** Seat numbers with seat 1 on the button, 2 and 3 the blinds, then the rest in preflop order. */
function seatNumbers(seats: readonly ScriptPosition[]): Partial<Record<ScriptPosition, number>> {
  const out: Partial<Record<ScriptPosition, number>> = { BTN: 1, SB: 2, BB: 3 };
  let next = 4;
  for (const position of seats) if (out[position] === undefined) out[position] = next++;
  return out;
}
/** Postflop order: the small blind acts first. */
export const POSTFLOP_ORDER: readonly ScriptPosition[] = ["SB", "BB", "UTG", "HJ", "CO", "BTN"];

/** The hero's screen name in every trainer hand. Data, not prose: it is the name a hand history carries. */
export const HERO_NAME = "Hero";

export interface ScriptAct {
  position: ScriptPosition;
  type: "fold" | "check" | "call" | "bet" | "raise";
  /** Bet or raise: the actor's total on the street after the action, in bb. */
  to?: number;
}

export interface HandScript {
  /** Hand number: letters, digits, `_` and `-`. */
  id: string;
  /** The table, in preflop order; `SCRIPT_POSITIONS` (6-max) when absent. */
  seats?: readonly ScriptPosition[];
  hero: ScriptPosition;
  /** The hero's hole cards, e.g. `["Ah", "Kd"]`; null deals them face down. */
  heroCards: readonly [string, string] | null;
  /** Every player's starting stack, bb. */
  stackBb: number;
  preflop: readonly ScriptAct[];
  /** Up to five cards; a street is dealt only when it has a list of actions (possibly empty). */
  board?: readonly string[];
  flop?: readonly ScriptAct[];
  turn?: readonly ScriptAct[];
  river?: readonly ScriptAct[];
}

/** The money as the script goes: what is in the middle and what each player has behind. */
export interface ScriptMoney {
  /** Pot at the start of each street that was dealt, bb (every chip in, blinds included). */
  streetPot: Partial<Record<"flop" | "turn" | "river", number>>;
  /** Behind at the start of each dealt street, per position, bb. */
  streetBehind: Partial<Record<"flop" | "turn" | "river", Partial<Record<ScriptPosition, number>>>>;
  /** Pot now (after the last scripted action), bb. */
  pot: number;
  /** Each position's stack behind now, bb. */
  behind: Record<ScriptPosition, number>;
  /** Each position's total on the current street now, bb. */
  streetTotal: Record<ScriptPosition, number>;
  /** The highest street total now, bb. */
  high: number;
  /** Positions that folded. */
  folded: ScriptPosition[];
}

export class ScriptError extends Error {}

const cents = (bb: number) => Math.round(bb * 100);
const bbOf = (value: number) => value / 100;
/** `$2.5`, `$100`, `$0.33`: dollars with no trailing zeros, as the standard text writes them. */
function money(value: number): string {
  const text = (value / 100).toFixed(2).replace(/\.?0+$/, "");
  return `$${text}`;
}

function nameOf(script: HandScript, position: ScriptPosition): string {
  return position === script.hero ? HERO_NAME : position;
}

interface Lines {
  lines: string[];
  money: ScriptMoney;
}

/** The script as text, and the money state after its last action. Throws `ScriptError` on an impossible script. */
function write(script: HandScript): Lines {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(script.id)) throw new ScriptError(`bad hand id ${script.id}`);
  const positions = seatsOf(script);
  const seatNo = seatNumbers(positions) as Record<ScriptPosition, number>;
  const stack = cents(script.stackBb);
  const behind = Object.fromEntries(positions.map((p) => [p, stack])) as Record<ScriptPosition, number>;
  let totals = Object.fromEntries(positions.map((p) => [p, 0])) as Record<ScriptPosition, number>;
  const folded = new Set<ScriptPosition>();
  let pot = 0;
  let high = 0;
  const streetPot: ScriptMoney["streetPot"] = {};
  const streetBehind: ScriptMoney["streetBehind"] = {};

  const lines: string[] = [
    `Poker Hand #${script.id}: Hold'em No Limit ($0.5/$1) - 2026/01/01 12:00:00`,
    `Table 'Rail trainer' ${positions.length}-max Seat #1 is the button`,
  ];
  const bySeat = [...positions].sort((a, b) => seatNo[a] - seatNo[b]);
  for (const position of bySeat) {
    lines.push(`Seat ${seatNo[position]}: ${nameOf(script, position)} (${money(stack)} in chips)`);
  }
  const post = (position: ScriptPosition, amount: number, word: string) => {
    behind[position] -= amount;
    totals[position] += amount;
    pot += amount;
    high = Math.max(high, totals[position]);
    lines.push(`${nameOf(script, position)}: posts ${word} blind ${money(amount)}`);
  };
  post("SB", 50, "small");
  post("BB", 100, "big");
  lines.push("*** HOLE CARDS ***");
  lines.push(script.heroCards ? `Dealt to ${HERO_NAME} [${script.heroCards.join(" ")}]` : `Dealt to ${HERO_NAME}`);

  const act = (a: ScriptAct) => {
    if (folded.has(a.position)) throw new ScriptError(`${a.position} acts after folding`);
    const name = nameOf(script, a.position);
    const mine = totals[a.position];
    switch (a.type) {
      case "fold":
        folded.add(a.position);
        lines.push(`${name}: folds`);
        return;
      case "check":
        if (high > mine) throw new ScriptError(`${a.position} checks facing a bet`);
        lines.push(`${name}: checks`);
        return;
      case "call": {
        const amount = Math.min(high - mine, behind[a.position]);
        if (!(amount > 0)) throw new ScriptError(`${a.position} calls nothing`);
        behind[a.position] -= amount;
        totals[a.position] += amount;
        pot += amount;
        lines.push(`${name}: calls ${money(amount)}${behind[a.position] === 0 ? " and is all-in" : ""}`);
        return;
      }
      case "bet":
      case "raise": {
        if (a.to === undefined) throw new ScriptError(`${a.position} ${a.type}s without a size`);
        const to = Math.min(cents(a.to), mine + behind[a.position]);
        if (!(to > high)) throw new ScriptError(`${a.position} ${a.type}s to ${to} facing ${high}`);
        const amount = to - mine;
        behind[a.position] -= amount;
        totals[a.position] = to;
        pot += amount;
        const allIn = behind[a.position] === 0 ? " and is all-in" : "";
        if (a.type === "bet" && high === 0) {
          lines.push(`${name}: bets ${money(amount)}${allIn}`);
        } else {
          lines.push(`${name}: raises ${money(to - high)} to ${money(to)}${allIn}`);
        }
        high = to;
        return;
      }
    }
  };

  for (const a of script.preflop) act(a);
  const board = script.board ?? [];
  const streets: Array<["flop" | "turn" | "river", readonly ScriptAct[] | undefined, number]> = [
    ["flop", script.flop, 3],
    ["turn", script.turn, 4],
    ["river", script.river, 5],
  ];
  for (const [street, acts, cards] of streets) {
    if (!acts) break;
    if (board.length < cards) throw new ScriptError(`no ${street} card`);
    totals = Object.fromEntries(positions.map((p) => [p, 0])) as Record<ScriptPosition, number>;
    high = 0;
    streetPot[street] = bbOf(pot);
    streetBehind[street] = Object.fromEntries(
      positions.filter((p) => !folded.has(p)).map((p) => [p, bbOf(behind[p])]),
    );
    const shown = board.slice(0, cards);
    if (street === "flop") lines.push(`*** FLOP *** [${shown.join(" ")}]`);
    else lines.push(`*** ${street.toUpperCase()} *** [${shown.slice(0, cards - 1).join(" ")}] [${shown[cards - 1]}]`);
    for (const a of acts) act(a);
  }

  lines.push("*** SUMMARY ***");
  lines.push(`Total pot ${money(pot)} | Rake $0 | Jackpot $0 | Bingo $0 | Fortune $0 | Tax $0`);
  return {
    lines,
    money: {
      streetPot,
      streetBehind,
      pot: bbOf(pot),
      behind: Object.fromEntries(positions.map((p) => [p, bbOf(behind[p])])) as Record<ScriptPosition, number>,
      streetTotal: Object.fromEntries(positions.map((p) => [p, bbOf(totals[p])])) as Record<ScriptPosition, number>,
      high: bbOf(high),
      folded: [...folded],
    },
  };
}

/** The script as standard hand-history text. */
export function scriptText(script: HandScript): string {
  return write(script).lines.join("\n");
}

/** The money after the script's last action. */
export function scriptMoney(script: HandScript): ScriptMoney {
  return write(script).money;
}

const PARSE_CONTEXT = { siteId: "standard", siteName: "Rail trainer", originalFilename: null };

/** The script as a parsed hand. Throws `ScriptError` when the parser refuses it (a bug in the script). */
export function scriptHand(script: HandScript): PhfHand {
  const text = scriptText(script);
  const hand = parseStandardHand(text, PARSE_CONTEXT);
  if (!hand) throw new ScriptError(`the trainer's hand did not parse:\n${text}`);
  return hand;
}

/**
 * The script with everyone who has not acted yet acting once after its last
 * preflop action: a fold facing a bet, a check otherwise.
 *
 * A hand history names a seat "dealt in" by its actions (`dealtInSeatsOf` in
 * `lib/phf/types.ts`), so a hand that stops at an early decision would leave
 * the players behind it out of the ring — and with them the table size and
 * every position the charts read. Completing the orbit after the decision
 * that matters changes nothing before it.
 */
export function completePreflop(script: HandScript): HandScript {
  const acted = new Set(script.preflop.map((a) => a.position));
  const rest = seatsOf(script).filter((p) => !acted.has(p));
  if (rest.length === 0) return script;
  const preflop = [...script.preflop];
  for (const position of rest) {
    const money = scriptMoney({ ...script, preflop, board: undefined, flop: undefined, turn: undefined, river: undefined });
    preflop.push({ position, type: money.high > money.streetTotal[position] ? "fold" : "check" });
  }
  return { ...script, preflop, board: undefined, flop: undefined, turn: undefined, river: undefined };
}

/** Seat number of a position in a trainer hand at this table (6-max by default). */
export function seatOf(position: ScriptPosition, seats: readonly ScriptPosition[] = SCRIPT_POSITIONS): number {
  return seatNumbers(seats)[position] ?? -1;
}

const DECISIONS = new Set(["fold", "check", "call", "bet", "raise"]);

/** The hero's last decision in a hand, or null. */
export function lastHeroDecision(hand: PhfHand): PhfAction | null {
  const hero = hand.players.find((player) => player.isHero);
  if (!hero) return null;
  let last: PhfAction | null = null;
  for (const action of hand.actions) {
    if (action.seat === hero.seat && DECISIONS.has(action.type)) last = action;
  }
  return last;
}

/**
 * The hand as it stood before the action at `stop`: what a player sees when
 * the decision is theirs. The forum's "what would you do?" spot
 * (`poll_phf`, `20261130090000_forum_polls.sql`) made pure:
 *
 * - actions strictly before `stop`;
 * - the first runout only, through the decision's street;
 * - the hero's hole cards (unless `hideHero`), never anyone else's;
 * - no results, winners, chip movements, source text or warnings.
 *
 * `stop` past the last action keeps every action (a spot built to end at the
 * decision). Does not mutate `hand`.
 */
export function handUpTo(hand: PhfHand, stop: number, hideHero = false): PhfHand {
  const at = hand.actions.find((action) => action.index === stop);
  const last = hand.actions[hand.actions.length - 1];
  const street = at?.street ?? last?.street ?? "preflop";
  const shownStreet = street === "showdown" ? "river" : street;
  const run = hand.board.runouts[0];
  const reached = (s: "flop" | "turn" | "river") => {
    const order = ["preflop", "flop", "turn", "river"];
    return order.indexOf(shownStreet) >= order.indexOf(s);
  };
  return {
    ...hand,
    actions: hand.actions.filter((action) => action.index < stop).map((action) => ({ ...action })),
    players: hand.players.map((player) => ({
      ...player,
      holeCards: player.isHero && !hideHero ? [...player.holeCards] : [],
      dealtCards: player.isHero && !hideHero ? [...player.dealtCards] : [],
    })),
    board: {
      runouts: [
        {
          index: 0,
          flop: reached("flop") && run?.flop ? [...run.flop] : null,
          turn: reached("turn") ? (run?.turn ?? null) : null,
          river: reached("river") ? (run?.river ?? null) : null,
          markerLabels: {},
          summaryCards: null,
        },
      ],
    },
    chipMovements: [],
    results: {
      ...hand.results,
      totalPot: 0,
      pots: [],
      players: [],
      winners: [],
      heroNet: null,
      wentToShowdown: false,
      streetReached: shownStreet,
    },
    meta: { ...hand.meta, rawText: "", warnings: [] },
  };
}
