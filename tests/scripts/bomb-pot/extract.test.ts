/**
 * Bomb pot study, step 1: every postflop action in the learner's bomb pots,
 * with what the actor turned out to hold when the cards were shown, and what
 * Rail's multiway narrowing (the model the bomb pot grades rest on) thought
 * they held right after that action. Writes LOCAL JSONL (never committed:
 * derived from someone's hands).
 *
 *     cd tests && BOMB_HANDS=/path/hands.jsonl BOMB_OUT=/path/actions.jsonl \
 *       npx vitest run --config scripts/bomb-pot/vitest.config.ts extract
 */

import { readFileSync, writeFileSync } from "node:fs";
import { it } from "vitest";

import { heroSeatOf, walkMultiway } from "../../../web/src/lib/analysis/index.js";
import { toIndices } from "../../../web/src/lib/analysis/texture.js";
import { categoryOf, evaluate } from "../../../web/src/lib/equity/evaluator.js";
import type { PhfHand } from "../../../web/src/lib/phf/types.js";
import { comboCards, NUM_COMBOS } from "../../../web/src/lib/solver/index.js";
import { buildContext } from "../../../web/src/lib/stats/context.js";

type Street = "flop" | "turn" | "river";
const STREETS: Street[] = ["flop", "turn", "river"];
const SYNTH = 1_000_000;
const DECISION_TYPES = new Set(["check", "bet", "call", "raise", "fold"]);

/** Every live combo's percentile on `board` (share of the other live combos it beats, ties half), and its category. */
function strengthTable(board: number[]): { pct: Float64Array; cat: string[] } {
  const dead = new Set(board);
  const values = new Float64Array(NUM_COMBOS).fill(-1);
  const live: number[] = [];
  for (let c = 0; c < NUM_COMBOS; c += 1) {
    const [a, b] = comboCards(c);
    if (dead.has(a) || dead.has(b)) continue;
    values[c] = evaluate([a, b, ...board]);
    live.push(c);
  }
  const sorted = live.map((c) => values[c]).sort((x, y) => x - y);
  const below = (v: number) => {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const above = (v: number) => {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= v) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const pct = new Float64Array(NUM_COMBOS).fill(-1);
  const cat: string[] = new Array(NUM_COMBOS).fill("");
  for (const c of live) {
    const lt = below(values[c]);
    const eq = above(values[c]) - lt - 1;
    pct[c] = (lt + eq / 2) / (sorted.length - 1);
    cat[c] = categoryOf(values[c]);
  }
  return { pct, cat };
}

function boardAt(hand: PhfHand, street: Street): number[] {
  const r = hand.board.runouts[0];
  const codes = [...(r?.flop ?? [])];
  if (street !== "flop" && r?.turn) codes.push(r.turn);
  if (street === "river" && r?.river) codes.push(r.river);
  return toIndices(codes);
}

it("extracts bomb pot actions", () => {
  const input = process.env.BOMB_HANDS;
  const output = process.env.BOMB_OUT;
  if (!input || !output) throw new Error("set BOMB_HANDS and BOMB_OUT");
  const lines = readFileSync(input, "utf8").split("\n").filter(Boolean);
  const out: string[] = [];
  const handsOut: string[] = [];
  const showdowns: string[] = [];
  let walked = 0, refused = 0;
  for (const line of lines) {
    const raw = JSON.parse(line) as PhfHand & { _key: string; _grade: string | null; _evloss: number | null };
    const hand = raw as PhfHand;
    if (hand.game.bombPot?.doubleBoard || hand.board.runouts.length !== 1) continue;
    const context = buildContext(structuredClone(hand));
    const hero = heroSeatOf(context);
    const bb = Math.max(1, hand.game.bigBlind);
    const heroPlayer = hand.players.find((p) => p.isHero);
    handsOut.push(JSON.stringify({
      key: raw._key,
      bb,
      anteBb: (hand.game.bombPot?.ante ?? 0) / bb,
      players: hand.players.filter((p) => !p.sittingOut).length,
      heroNetBb: (hand.results.heroNet ?? 0) / bb,
      heroStackBb: (heroPlayer?.startingStack ?? 0) / bb,
      showdown: hand.results.wentToShowdown,
      grade: raw._grade,
      evLoss: raw._evloss,
    }));
    if (hero === null) continue;
    let walk: ReturnType<typeof walkMultiway> | null = null;
    try {
      // A synthetic last check by a seat at showdown: its snapshot is every live range after the real last action.
      const probe = structuredClone(hand);
      const lastSeat = hand.results.players.find((q) => q.wentToShowdown)?.seat ?? hero;
      probe.actions.push({ ...structuredClone(hand.actions[hand.actions.length - 1]), index: SYNTH, type: "check", street: "river", seat: lastSeat, amount: 0, allIn: false, streetTotal: 0 } as PhfHand["actions"][number]);
      walk = walkMultiway(probe, buildContext(structuredClone(probe)), hero, null);
    } catch {
      walk = null;
    }
    if (!walk || !walk.ok) { refused += 1; continue; }
    walked += 1;
    const tables = new Map<Street, ReturnType<typeof strengthTable>>();
    const table = (s: Street) => {
      if (!tables.has(s)) tables.set(s, strengthTable(boardAt(hand, s)));
      return tables.get(s)!;
    };
    const acts = hand.actions.filter((a) => STREETS.includes(a.street as Street) && ["check", "bet", "call", "raise", "fold"].includes(a.type));
    const folded = new Set<number>();
    // Per street: who checked, the pot before each action.
    let pot = hand.actions.filter((a) => a.street === "preflop").reduce((s, a) => s + (a.amount ?? 0), 0);
    let street: Street | null = null;
    let checked = new Set<number>();
    let streetPut = new Map<number, number>();
    let aggressions = 0;
    let lastAggressor: number | null = null;
    let prevAggressor: number | null = null;
    for (let i = 0; i < acts.length; i += 1) {
      const a = acts[i];
      const s = a.street as Street;
      if (s !== street) {
        street = s; checked = new Set(); streetPut = new Map(); prevAggressor = lastAggressor; lastAggressor = null; aggressions = 0;
      }
      const seat = a.seat as number;
      const live = hand.players.filter((p) => !folded.has(p.seat) && !p.sittingOut).length;
      const put = streetPut.get(seat) ?? 0;
      const high = Math.max(0, ...streetPut.values());
      const toCall = high - put;
      const add = a.type === "bet" || a.type === "raise" ? (a.streetTotal ?? a.amount) - put : a.type === "call" ? a.amount : 0;
      const sizePot = a.type === "bet" ? add / Math.max(1, pot) : a.type === "raise" ? (add - toCall) / Math.max(1, pot + toCall) : null;
      const kind = a.type === "raise" && checked.has(seat) ? "check-raise" : a.type;
      const facing = aggressions === 0 ? "unbet" : aggressions === 1 ? "vs-bet" : "vs-raise";
      const player = hand.players.find((p) => p.seat === seat);
      const shown = player?.holeCards && player.holeCards.length === 2 ? toIndices(player.holeCards) : null;
      const next = hand.actions.find((b) => b.index > a.index && DECISION_TYPES.has(b.type) && b.street !== "preflop");
      const after = walk.before(next ? next.index : SYNTH);
      const range = after?.get(seat) ?? null;
      const { pct, cat } = table(s);
      let modelPct: number | null = null, modelStrong: number | null = null, modelWeak: number | null = null;
      if (range && a.type !== "fold") {
        let w = 0, sp = 0, strong = 0, weak = 0;
        for (let c = 0; c < NUM_COMBOS; c += 1) {
          if (range[c] <= 0 || pct[c] < 0) continue;
          w += range[c]; sp += range[c] * pct[c];
          if (pct[c] >= 0.8) strong += range[c];
          if (pct[c] < 0.5) weak += range[c];
        }
        if (w > 0) { modelPct = sp / w; modelStrong = strong / w; modelWeak = weak / w; }
      }
      let shownPct: number | null = null, shownCat: string | null = null;
      if (shown) {
        const [x, y] = shown;
        const hi = Math.max(x, y), lo = Math.min(x, y);
        // comboIndex via search (comboCards is the inverse).
        for (let c = 0; c < NUM_COMBOS; c += 1) {
          const [p, q] = comboCards(c);
          if ((p === hi && q === lo) || (p === lo && q === hi)) { shownPct = pct[c]; shownCat = cat[c]; break; }
        }
      }
      out.push(JSON.stringify({
        key: raw._key, street: s, kind, facing, live, hero: player?.isHero === true, seat,
        position: player?.position ?? null,
        sizePot, toCallPot: toCall > 0 ? toCall / Math.max(1, pot) : 0,
        prevAggressor: prevAggressor === seat, prevAggressorOther: prevAggressor !== null && prevAggressor !== seat,
        modelPct, modelStrong, modelWeak, shownPct, shownCat,
        anteBb: (hand.game.bombPot?.ante ?? 0) / bb,
        spr: (Math.min(...hand.players.filter((p) => !folded.has(p.seat)).map((p) => p.startingStack ?? 0)) / Math.max(1, pot)),
      }));
      // Book-keeping after the action.
      if (a.type === "check") checked.add(seat);
      if (a.type === "fold") folded.add(seat);
      if (a.type === "bet" || a.type === "raise") { aggressions += 1; lastAggressor = seat; streetPut.set(seat, a.streetTotal ?? put + a.amount); pot += add; }
      if (a.type === "call") { streetPut.set(seat, put + a.amount); pot += a.amount; }
    }
    // Every seat that reached a river showdown: its whole line, whether it showed or won, and the model's final range.
    const finalRanges = walk.before(SYNTH);
    const river = hand.board.runouts[0]?.river;
    if (finalRanges && river) {
      const { pct } = table("river");
      for (const res of hand.results.players) {
        if (!res.wentToShowdown) continue;
        const range = finalRanges.get(res.seat);
        if (!range) continue;
        let w = 0, sp = 0, strong = 0;
        for (let c = 0; c < NUM_COMBOS; c += 1) {
          if (range[c] <= 0 || pct[c] < 0) continue;
          w += range[c]; sp += range[c] * pct[c]; if (pct[c] >= 0.8) strong += range[c];
        }
        const player = hand.players.find((p) => p.seat === res.seat);
        const line = STREETS.map((st) => acts.filter((b) => b.seat === res.seat && b.street === st).map((b) => b.type[0] === "c" && b.type === "check" ? "x" : b.type === "call" ? "c" : b.type === "bet" ? "b" : b.type === "raise" ? "r" : "f").join("")).join("|");
        let shownPct: number | null = null;
        if (player?.holeCards?.length === 2) {
          const [x, y] = toIndices(player.holeCards);
          for (let c = 0; c < NUM_COMBOS; c += 1) {
            const [p, q] = comboCards(c);
            if ((p === x && q === y) || (p === y && q === x)) { shownPct = pct[c]; break; }
          }
        }
        showdowns.push(JSON.stringify({
          key: raw._key, seat: res.seat, hero: player?.isHero === true, line,
          won: res.net > 0, mucked: res.mucked, shownPct,
          modelPct: w > 0 ? sp / w : null, modelStrong: w > 0 ? strong / w : null,
          players: hand.results.players.filter((q) => q.wentToShowdown).length,
        }));
      }
    }
  }
  writeFileSync(output, out.join("\n") + "\n");
  writeFileSync(output.replace(/\.jsonl$/, ".showdowns.jsonl"), showdowns.join("\n") + "\n");
  writeFileSync(output.replace(/\.jsonl$/, ".hands.jsonl"), handsOut.join("\n") + "\n");
  console.log(`hands ${lines.length}, walked ${walked}, refused ${refused}, actions ${out.length}`);
});
