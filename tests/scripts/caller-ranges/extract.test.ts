/**
 * Step 1 of the caller-range study (analysis/19): every opponent whose hole
 * cards a hand shows, with their preflop line and what each candidate range
 * needs - the placeholder, the range the walks read today, and the chart node
 * of their last preflop decision (own depth, else a neighbouring depth) with
 * its per-class frequencies and EVs. Written to a LOCAL JSONL file (never
 * committed: it is derived from someone's hands).
 *
 *     cd tests && CALLERS_HANDS=/path/library.jsonl CALLERS_OUT=/path/shown.jsonl \
 *       npx vitest run --config scripts/caller-ranges/vitest.config.ts extract
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";

import { preflopClassRange } from "../../../frontend/src/lib/analysis/rangeWalk.js";
import { defaultRange, preflopLine } from "../../../frontend/src/lib/analysis/ranges.js";
import {
  CHART_SETS,
  chartLibrary,
  DEFAULT_CHART_SET,
  effectiveStackBb,
  handClassOf,
  loadCharts,
  lookupPreflop,
  preflopSpotFromHand,
  type ChartSet,
} from "../../../frontend/src/lib/charts/index.js";
import { allClasses, type ClassWeights } from "../../../frontend/src/lib/equity/range.js";
import type { PhfHand, Position } from "../../../frontend/src/lib/phf/types.js";
import { buildContext } from "../../../frontend/src/lib/stats/context.js";

const DATA = join(import.meta.dirname, "../../../frontend/src/lib/charts/data");
const FILE = process.env.CALLERS_HANDS ?? "";
const OUT = process.env.CALLERS_OUT ?? "";
const DECISIONS = new Set(["fold", "check", "call", "bet", "raise"]);
const NAMES = allClasses();

const vec = (weights: ClassWeights): number[] => {
  const out = new Array<number>(169).fill(0);
  for (const [name, w] of weights) {
    const k = handClassOf(name);
    if (k >= 0) out[k] = Math.round(w * 1e4) / 1e4;
  }
  return out;
};
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

it("extracts shown opponents", () => {
  if (!FILE || !existsSync(FILE) || !OUT) {
    console.log("CALLERS_HANDS and CALLERS_OUT must be set; nothing to do");
    return;
  }
  const hands: PhfHand[] = readFileSync(FILE, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as PhfHand);
  const load = (id: string) => loadCharts(JSON.parse(readFileSync(join(DATA, `${id}.json`), "utf8")));
  const sets = CHART_SETS.map((spec) => load(spec.id));
  const single = sets.find((s) => s.id === DEFAULT_CHART_SET) as ChartSet;
  const charts = chartLibrary([single, ...sets.filter((s) => s !== single)]);

  const out: string[] = [];
  const skipped = new Map<string, number>();
  const tally = new Map<string, number>();
  const bump = (k: string) => skipped.set(k, (skipped.get(k) ?? 0) + 1);
  for (const [h, hand] of hands.entries()) {
    if (hand.actions.some((a) => a.type === "ante" || a.type === "straddle" || a.type === "bomb-ante")) {
      bump("ante/straddle/bomb");
      continue;
    }
    const context = buildContext(structuredClone(hand));
    const firstPostflop = hand.actions.find((a) => a.street !== "preflop" && a.street !== "showdown");
    const cut = firstPostflop?.index ?? Number.MAX_SAFE_INTEGER;
    for (const player of hand.players) {
      if (player.isHero) continue;
      const seat = player.seat;
      const k = player.holeCards.length === 2 ? handClassOf(player.holeCards) : -1;
      const villain = createHash("sha256").update(`${hand.meta.siteId}:${player.name}`).digest("hex").slice(0, 12);
      const line = preflopLine(context, seat);
      if (line === "unknown") {
        bump("unknown line");
        continue;
      }
      const position = (context.position.get(seat) ?? null) as Position | null;
      // The seat's preflop decisions; the last one decides the line.
      const mine = hand.actions.filter((a) => a.street === "preflop" && a.seat === seat && DECISIONS.has(a.type) && a.index < cut);
      if (mine.length === 0) continue;
      const nth = mine.length - 1;
      const found = preflopSpotFromHand(hand, nth, seat);
      if (!found.ok) {
        bump(`spot ${found.reason}`);
        continue;
      }
      const allIn = hand.actions.some((a) => a.street === "preflop" && a.allIn && a.index < cut);
      const decisions = (context.byStreet.get("preflop") ?? []).filter(
        (d) => d.seat === seat && (d.type === "call" || d.type === "raise" || d.type === "bet"),
      );
      const last = decisions[decisions.length - 1];
      const first = decisions[0];
      let source: string = line;
      if (line === "call") {
        if (position !== "SB" && position !== "BB" && first && first.type === "call" && first.raisesBefore === 0) source = "limp-call";
        else source = position === "BB" ? "bb-defence" : "cold-call";
      } else if (line === "limp") {
        if (position === "SB") source = last && last.enteredBefore.length > 0 ? "sb-over-limp" : "sb-limp";
        else if (position === "BB") source = "bb-limp";
        else source = last && last.enteredBefore.length > 0 ? "over-limp" : "first-limp";
      }
      // Every opponent's line that went past preflop, shown or not: how often each villain plays it.
      if (context.foldedOn.get(seat) !== "preflop") {
        const key = `${villain} ${source}`;
        tally.set(key, (tally.get(key) ?? 0) + 1);
      }
      if (k < 0) continue;
      // Price of the last decision.
      const spot = found.spot;
      let high = 1;
      let raises = 0;
      let opener: string | null = null;
      let limpers = 0;
      let callers = 0;
      const inBy = new Map<string, number>([
        ["SB", 0.5],
        ["BB", 1],
      ]);
      for (const a of spot.actions) {
        if (a.type === "raise") {
          raises += 1;
          if (raises === 1) opener = a.position;
          callers = 0;
          high = Math.max(high, a.toBb ?? high);
          inBy.set(a.position, a.toBb ?? high);
        } else if (a.type === "call") {
          if (raises === 0) limpers += 1;
          else callers += 1;
          inBy.set(a.position, a.toBb ?? high);
        }
      }
      const pot = [...inBy.values()].reduce((s, v) => s + v, 0);
      const mineIn = inBy.get(spot.hero) ?? 0;
      const toCall = Math.max(0, high - mineIn);
      const depth = effectiveStackBb(spot);

      const nodeOf = (opts: object, how: string) => {
        const lookup = lookupPreflop(charts, spot, null, found.heroAction, opts);
        if (!lookup.ok || lookup.chosen === null || lookup.chosen < 0) return null;
        const n = lookup.node;
        return {
          how,
          set: lookup.set.id,
          line: n.line,
          actions: n.options.map((o) => o.action),
          toBb: n.options.map((o) => o.toBb),
          chosen: lookup.chosen,
          inBb: n.inBb,
          potBb: n.potBb,
          toMatchBb: n.toMatchBb,
          reach: n.reach,
          range: Array.from(n.range, r4),
          freq: Array.from(n.freq, r4),
          ev: Array.from(n.ev, (x) => Math.round(x * 1000) / 1000),
          approx: lookup.approximations.map((a) => a.kind),
        };
      };
      const node =
        nodeOf({}, "own") ?? nodeOf({ rareLineDepth: true, uncoveredDepth: true }, "neighbour");
      const current = preflopClassRange(hand, context, seat, cut, charts);
      const heroSeat = hand.players.find((p) => p.isHero)?.seat ?? -1;
      const shipped = preflopClassRange(hand, context, seat, cut, charts, { populationHero: heroSeat });
      out.push(
        JSON.stringify({
          h,
          date: hand.playedAt,
          villain,
          players: spot.positions.length,
          position,
          line,
          source,
          allIn,
          depth: r4(depth),
          toCall: r4(toCall),
          pot: r4(pot),
          raiseTo: r4(high),
          opener,
          limpers,
          callers,
          shown: k,
          placeholder: vec(defaultRange(line, position).range),
          current: current ? { source: current.source, label: current.label, approx: current.approx, range: vec(current.range) } : null,
          shipped: shipped ? { source: shipped.source, label: shipped.label, approx: shipped.approx, range: vec(shipped.range) } : null,
          node,
        }),
      );
    }
  }
  writeFileSync(OUT, out.join("\n") + "\n");
  console.log(`${out.length} shown opponents written; skipped ${[...skipped].map(([a, b]) => `${a} ${b}`).join(", ")}`);
  const names = new Array<string>(169);
  for (const name of NAMES) names[handClassOf(name)] = name;
  writeFileSync(`${OUT}.tally.json`, JSON.stringify(Object.fromEntries(tally)));
  writeFileSync(`${OUT}.classes.json`, JSON.stringify(names));
});
