/**
 * The trainer's short *why* (2026-11-19, canvas `ideas-trainer` A): what a
 * decision comes down to, as keys the dictionary words (`trainer.brief`):
 *
 * - a headline: the hand's role, then the play (`Thin value — bet small`);
 * - what the play is worth: the best option's EV over yours, or over the
 *   next best when you found it;
 * - at most three points, each one number that decides it;
 * - example hands from the range, grouped as the reference plays them, with
 *   the EV of the play they make.
 *
 * Built only from the graded decision and the range view; pure.
 */

import type { DecisionAnalysis, OptionAnalysis } from "../analysis/types";
import type { RangeView } from "./rangeView";

export type BriefRole =
  | "value"
  | "thin"
  | "trap"
  | "too-thin"
  | "showdown"
  | "bluff-catcher"
  | "bluff"
  | "give-up"
  | "weak"
  | "protect"
  | "vulnerable"
  | "semi-bluff"
  | "draw"
  | "medium"
  | "open"
  | "three-bet"
  | "four-bet"
  | "defend";

export type BriefPlay = "bet-small" | "bet-big" | "raise" | "allin" | "check" | "call" | "fold";

export interface BriefHead {
  role: BriefRole | null;
  /** The play, unless the role says it (`open`, `three-bet`, `four-bet`). */
  play: BriefPlay | null;
}

export type BriefGain =
  /** The best option over the one you chose. */
  | { kind: "over-yours"; best: number; other: number; bb: number }
  /** You chose the best one (or answered with a mix): over the next best. */
  | { kind: "found"; best: number; other: number; bb: number }
  /** The two best are worth the same. */
  | { kind: "equal"; best: number; other: number };

export type BriefPoint =
  | { kind: "beats"; beats: number }
  | { kind: "price"; need: number; have: number | null }
  | { kind: "equity"; equity: number }
  | { kind: "polar"; strong: number; weak: number }
  | { kind: "merged"; medium: number }
  | { kind: "removes"; strong: number; weak: number }
  | { kind: "blockers"; blockers: string[] }
  | { kind: "rivers-weak"; share: number }
  | { kind: "rivers-strong"; share: number }
  | { kind: "draws"; draws: string[] }
  | { kind: "spr"; spr: number }
  | { kind: "capped" }
  | { kind: "estimate" };

const AGGRESSIVE = new Set(["bet", "raise"]);
const isAggressive = (option: Pick<OptionAnalysis, "action">) => AGGRESSIVE.has(option.action);

/** The option with the highest EV. */
export function bestOption(decision: DecisionAnalysis): number | null {
  let best: number | null = null;
  decision.options.forEach((option, index) => {
    if (best === null || option.ev > decision.options[best].ev + 1e-9) best = index;
  });
  return best;
}

/** The play an option is, in a few words' worth of keys. */
export function playOf(option: Pick<OptionAnalysis, "action" | "allIn" | "sizePot">): BriefPlay {
  if (option.allIn) return "allin";
  if (option.action === "bet") return (option.sizePot ?? 0) > 0.5 ? "bet-big" : "bet-small";
  if (option.action === "raise") return "raise";
  return option.action === "check" ? "check" : option.action === "call" ? "call" : "fold";
}

/** The check's share in the reference's mix for the hand (0 when it cannot check). */
function checkShare(decision: DecisionAnalysis): number {
  return decision.options.filter((o) => o.action === "check").reduce((sum, o) => sum + o.freq, 0);
}

export function briefHead(decision: DecisionAnalysis): BriefHead | null {
  const best = bestOption(decision);
  if (best === null) return null;
  const option = decision.options[best];
  const play = playOf(option);
  const aggressive = isAggressive(option);
  const f = decision.facts;
  let role: BriefRole | null = null;

  if (decision.street === "preflop") {
    const scenario = f.preflopScenario ?? "";
    if (aggressive && scenario === "unopened") return { role: "open", play: null };
    if (aggressive && (scenario === "vs-open" || scenario === "squeeze")) return { role: "three-bet", play: null };
    if (aggressive && (scenario === "vs-3bet" || scenario === "vs-3bet-cold")) return { role: "four-bet", play: null };
    if (play === "call" && scenario === "vs-open" && (f.position === "BB" || f.position === "SB")) role = "defend";
    return { role, play };
  }

  const river = decision.source === "solver" ? f.river : null;
  const turn = decision.source === "solver" ? f.turn : null;
  if (river) {
    switch (river.role) {
      case "value":
        role = aggressive ? (checkShare(decision) >= 0.3 ? "thin" : "value") : play === "check" ? "trap" : "value";
        break;
      case "thin-value":
        role = aggressive ? "thin" : play === "check" ? "too-thin" : "thin";
        break;
      case "showdown":
        role = "showdown";
        break;
      case "bluff-catcher":
        role = "bluff-catcher";
        break;
      case "air":
        role = aggressive ? "bluff" : "give-up";
        break;
      case "weak":
        role = "weak";
        break;
    }
  } else if (turn) {
    switch (turn.role) {
      case "value":
        role = aggressive ? (checkShare(decision) >= 0.3 ? "thin" : "value") : play === "check" ? "trap" : "value";
        break;
      case "vulnerable":
        role = aggressive ? "protect" : "vulnerable";
        break;
      case "draw":
        role = aggressive ? "semi-bluff" : "draw";
        break;
      case "bluff-catcher":
        role = "bluff-catcher";
        break;
      case "medium":
        role = "medium";
        break;
      case "air":
        role = aggressive ? "bluff" : "give-up";
        break;
    }
  } else {
    // The flop (and an unsolved street): what the hand has against the range.
    const equity = f.equity?.value ?? null;
    if (aggressive && f.draws.length > 0 && (equity === null || equity < 0.55)) role = "semi-bluff";
    else if (equity !== null && equity >= 0.65) role = aggressive ? "value" : play === "check" ? "trap" : "value";
    else if (equity !== null && equity < 0.35) role = aggressive ? "bluff" : f.draws.length > 0 ? "draw" : play === "fold" ? "weak" : null;
  }
  return { role, play };
}

export function briefGain(decision: DecisionAnalysis): BriefGain | null {
  const best = bestOption(decision);
  if (best === null || decision.options.length < 2) return null;
  const chosen = decision.chosen;
  if (chosen !== null && chosen !== best) {
    const bb = decision.options[best].ev - decision.options[chosen].ev;
    if (bb > 0.005) return { kind: "over-yours", best, other: chosen, bb };
  }
  let other: number | null = null;
  decision.options.forEach((option, index) => {
    if (index === best) return;
    if (other === null || option.ev > decision.options[other].ev) other = index;
  });
  if (other === null) return null;
  const bb = decision.options[best].ev - decision.options[other].ev;
  return bb > 0.005 ? { kind: "found", best, other, bb } : { kind: "equal", best, other };
}

/** At most `max` points, the most telling first. */
export function briefPoints(decision: DecisionAnalysis, max = 3): BriefPoint[] {
  const f = decision.facts;
  const out: BriefPoint[] = [];
  const river = decision.source === "solver" ? f.river : null;
  const turn = decision.source === "solver" ? f.turn : null;
  const facing = f.toCallBb > 0 && f.potOdds !== null;
  const mwEv = decision.source === "approx" ? f.multiway?.ev : undefined;

  if (river) {
    out.push(facing ? { kind: "price", need: f.potOdds as number, have: river.heroBeats } : { kind: "beats", beats: river.heroBeats });
    if (river.villain.shape === "polar") out.push({ kind: "polar", strong: river.villain.strong, weak: river.villain.weak });
    else if (river.villain.shape === "merged" && river.role === "value") out.push({ kind: "merged", medium: river.villain.medium });
    if (Math.abs(river.blocks.strong - river.blocks.weak) >= 0.05) out.push({ kind: "removes", strong: river.blocks.strong, weak: river.blocks.weak });
  } else if (turn) {
    out.push(facing ? { kind: "price", need: f.potOdds as number, have: turn.equity } : { kind: "beats", beats: turn.heroBeats });
    if (turn.role === "vulnerable") out.push({ kind: "rivers-weak", share: turn.rivers.weak });
    else if (turn.role === "draw") out.push({ kind: "rivers-strong", share: turn.rivers.strong });
    else if (turn.villain.shape === "polar") out.push({ kind: "polar", strong: turn.villain.strong, weak: turn.villain.weak });
  } else {
    const equity = mwEv ? mwEv.equity : (f.equity?.value ?? null);
    if (facing) out.push({ kind: "price", need: f.potOdds as number, have: equity });
    else if (equity !== null) out.push({ kind: "equity", equity });
    if (f.draws.length > 0 && decision.street !== "preflop") out.push({ kind: "draws", draws: [...f.draws] });
    if (f.spr !== null && f.spr <= 3 && decision.street !== "preflop" && decision.street !== "river") out.push({ kind: "spr", spr: f.spr });
  }
  if (f.blockers.length > 0 && !out.some((p) => p.kind === "removes")) out.push({ kind: "blockers", blockers: [...f.blockers] });

  const capped = mwEv?.capped ?? turn?.capped ?? river?.capped;
  const caveat: BriefPoint | null = capped ? { kind: "capped" } : mwEv ? { kind: "estimate" } : null;
  const points = out.slice(0, caveat ? max - 1 : max);
  return caveat ? [...points, caveat] : points;
}

/* ------------------------------------------------------------ examples - */

export type ExampleKey = "value" | "thin" | "bluff" | "raise" | "bet" | "call" | "check" | "fold";

export interface ExampleHand {
  /** `AhJh`, or a class (`K9o`) where the reference has no combos. */
  hand: string;
  /** The class's grid cell (what a click highlights). */
  cell: number;
  /** The option it plays (the group's most frequent one for the hand). */
  option: number;
  /** EV of that option, bb; null where the reference has none. */
  ev: number | null;
  /** How often it takes the group's play. */
  freq: number;
  /** The hero's own hand. */
  me: boolean;
}

export interface ExampleGroup {
  key: ExampleKey;
  hands: ExampleHand[];
}

const RANKS = "AKQJT98765432";

/** Grid distance between two cells (row and column apart). */
function distance(a: number, b: number): number {
  return Math.max(Math.abs(Math.floor(a / 13) - Math.floor(b / 13)), Math.abs((a % 13) - (b % 13)));
}

/** The grid cell of a class name (`AKs`, `72o`, `TT`). */
export function cellOf(name: string): number {
  const a = RANKS.indexOf(name[0]);
  const b = RANKS.indexOf(name[1]);
  if (a < 0 || b < 0) return -1;
  if (a === b) return a * 13 + a;
  const hi = Math.min(a, b);
  const lo = Math.max(a, b);
  return name[2] === "s" ? hi * 13 + lo : lo * 13 + hi;
}

function familyOf(option: RangeView["options"][number]): ExampleKey {
  if (option.action === "bet" || option.action === "raise") return option.action;
  return option.action === "call" ? "call" : option.action === "check" ? "check" : "fold";
}

/** Argmax of `freq` over `among`. */
function topOf(freq: number[], among: number[]): number {
  let top = among[0];
  for (const a of among) if ((freq[a] ?? 0) > (freq[top] ?? 0)) top = a;
  return top;
}

/**
 * Example hands from the range, grouped as the reference plays them.
 *
 * First to act on a solved street, the hands that mostly bet are split by
 * how much of the opponent's range they beat: value (and thin value, when
 * they still check a lot or beat little more than half) against bluffs.
 * Everywhere else, by the play itself: raise, call, fold. Each group shows
 * `per` hands, the hero's own first when it belongs there.
 */
export function rangeExamples(view: RangeView, per = 2): ExampleGroup[] {
  const heroCell = cellOf(view.heroClass);
  const aggressive = view.options.map((o, a) => (o.action === "bet" || o.action === "raise" ? a : -1)).filter((a) => a >= 0);
  const check = view.options.findIndex((o) => o.action === "check");

  if (view.combos && view.combos.length > 0 && view.toCall === 0 && aggressive.length > 0) {
    const groups: Record<"value" | "thin" | "bluff", Array<ExampleHand & { score: number }>> = { value: [], thin: [], bluff: [] };
    for (const combo of view.combos) {
      if (!(combo.weight > 0)) continue;
      const bet = aggressive.reduce((sum, a) => sum + (combo.freq[a] ?? 0), 0);
      if (bet < 0.5) continue;
      const option = topOf(combo.freq, aggressive);
      const checks = check >= 0 ? (combo.freq[check] ?? 0) : 0;
      const key = combo.hs < 0.5 ? "bluff" : combo.hs < 0.7 || checks >= 0.3 ? "thin" : "value";
      groups[key].push({
        hand: combo.cards,
        cell: combo.cell,
        option,
        ev: combo.ev[option] ?? null,
        freq: bet,
        me: combo.cards === view.heroCombo,
        score: combo.weight * bet,
      });
    }
    return (["value", "thin", "bluff"] as const)
      .map((key) => ({ key, hands: pick(groups[key], per) }))
      .filter((group) => group.hands.length > 0);
  }

  // By the play: one group per family (raise/bet, call/check, fold).
  const families = new Map<ExampleKey, number[]>();
  view.options.forEach((option, a) => {
    const key = familyOf(option);
    families.set(key, [...(families.get(key) ?? []), a]);
  });
  const order: ExampleKey[] = ["raise", "bet", "call", "check", "fold"];
  let groups = order
    .filter((key) => families.has(key))
    .map((key) => {
      const among = families.get(key) as number[];
      const hands: Array<ExampleHand & { score: number }> = [];
      view.cells.forEach((cell, k) => {
        if (!(cell.combos > 0)) return;
        const share = among.reduce((sum, a) => sum + (cell.freq[a] ?? 0), 0);
        if (share < 0.6) return;
        const option = topOf(cell.freq, among);
        const combo = view.combos ? bestCombo(view, k, among) : null;
        hands.push({
          hand: combo?.cards ?? cell.name,
          cell: k,
          option,
          ev: combo ? (combo.ev[option] ?? null) : (cell.ev?.[option] ?? null),
          freq: share,
          me: k === heroCell,
          // The hands next to the hero's teach the line best.
          score: heroCell >= 0 ? -distance(k, heroCell) * 100 + cell.combos : cell.combos,
        });
      });
      return { key, hands: pick(hands, per) };
    })
    .filter((group) => group.hands.length > 0);
  if (groups.length > 3) groups = groups.filter((g) => g.key !== "fold").slice(0, 3);
  return groups;
}

function bestCombo(view: RangeView, cell: number, among: number[]) {
  let best: NonNullable<RangeView["combos"]>[number] | null = null;
  let bestShare = -1;
  for (const combo of view.combos ?? []) {
    if (combo.cell !== cell || !(combo.weight > 0)) continue;
    if (combo.cards === view.heroCombo) return combo;
    const share = among.reduce((sum, a) => sum + (combo.freq[a] ?? 0), 0);
    if (share > bestShare) {
      best = combo;
      bestShare = share;
    }
  }
  return best;
}

/** The hero's hand first, then the best-scoring ones, one per class. */
function pick(hands: Array<ExampleHand & { score: number }>, per: number): ExampleHand[] {
  const out: ExampleHand[] = [];
  const seen = new Set<number>();
  const me = hands.find((h) => h.me);
  if (me) {
    out.push(strip(me));
    seen.add(me.cell);
  }
  for (const hand of [...hands].sort((a, b) => b.score - a.score)) {
    if (out.length >= per) break;
    if (seen.has(hand.cell)) continue;
    seen.add(hand.cell);
    out.push(strip(hand));
  }
  return out;
}

function strip(hand: ExampleHand & { score: number }): ExampleHand {
  return { hand: hand.hand, cell: hand.cell, option: hand.option, ev: hand.ev, freq: hand.freq, me: hand.me };
}
