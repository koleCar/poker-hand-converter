/**
 * The grades a narrowing change moves (§10, 2026-10-14): `analyzeHand` over
 * every stored hand whose flop three or more saw with the hero among them,
 * the hero's graded decisions written as `hand index, action index, street,
 * action, source, grade, EV loss` - no names, no cards - to
 * `CHECKTRIM_GRADES_OUT`. Run it once on the code before a change and once
 * after, then `CHECKTRIM_GRADES_BEFORE=before.json CHECKTRIM_GRADES_OUT=after.json`
 * prints the moved grades (counts, and the first few with board and cards to
 * the console only). Turn solves are off (`turn: false`, as the 2026-10-13
 * study counted): heads-up turns after a multiway flop keep no grade here.
 *
 * `CHECKTRIM_GRADES_HEADSUP=1` (§10, 2026-10-14, the heads-up check trim)
 * takes the hands whose flop two saw with the hero instead, the flop library
 * on as the analysis reads it. Turn solves stay off unless
 * `CHECKTRIM_GRADES_TURN=1` (heads-up turns are solved, not approximated).
 *
 *     cd tests && FLOPLIB_HANDS=... FLOPLIB_DIR=... CHECKTRIM_GRADES_OUT=/tmp/x.json npm run floplib:check-trim-grades
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";

import { analyzeHand, FlopLibraryLoader, flopSeats, heroSeatOf } from "../../../frontend/src/lib/analysis/index.js";
import { CHART_SETS, chartLibrary, DEFAULT_CHART_SET, loadCharts, type ChartSet } from "../../../frontend/src/lib/charts/index.js";
import type { PhfHand } from "../../../frontend/src/lib/phf/types.js";
import { buildContext } from "../../../frontend/src/lib/stats/context.js";

const DATA = join(import.meta.dirname, "../../../frontend/src/lib/charts/data");
const FILE = process.env.FLOPLIB_HANDS ?? "";
const DIR = process.env.FLOPLIB_DIR ?? "";
const OUT = process.env.CHECKTRIM_GRADES_OUT ?? "";
const BEFORE = process.env.CHECKTRIM_GRADES_BEFORE ?? "";
const HEADS_UP = process.env.CHECKTRIM_GRADES_HEADSUP === "1";
const TURN = process.env.CHECKTRIM_GRADES_TURN === "1";

type Graded = [hand: number, action: number, street: string, act: string, source: string, grade: string | null, evLoss: number | null];

const localFetch = async (url: string): Promise<Response> => {
  const path = join(DIR, url.replace(/^local:\/*/, ""));
  if (!existsSync(path)) return new Response(null, { status: 404 });
  return new Response(readFileSync(path));
};

it("grades the hero's decisions on multiway (or heads-up) flops", { timeout: 12 * 60 * 60_000 }, async () => {
  if (!FILE || !existsSync(FILE) || !DIR || !existsSync(DIR) || !OUT) {
    console.log("FLOPLIB_HANDS, FLOPLIB_DIR and CHECKTRIM_GRADES_OUT must be set; nothing to do");
    return;
  }
  const hands: PhfHand[] = readFileSync(FILE, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as PhfHand);
  const load = (id: string) => loadCharts(JSON.parse(readFileSync(join(DATA, `${id}.json`), "utf8")));
  const sets = CHART_SETS.map((spec) => load(spec.id));
  const single = sets.find((s) => s.id === DEFAULT_CHART_SET) as ChartSet;
  const charts = chartLibrary([single, ...sets.filter((s) => s !== single)]);
  const library = new FlopLibraryLoader("local:", localFetch);
  for (const spec of CHART_SETS) await library.ready(spec.id);

  const started = performance.now();
  const out: Graded[] = [];
  let analysed = 0;
  for (const [h, hand] of hands.entries()) {
    if (hand.actions.some((a) => a.type === "bomb-ante")) continue;
    const context = buildContext(structuredClone(hand));
    const seats = flopSeats(context);
    const hero = heroSeatOf(context);
    if ((HEADS_UP ? seats.length !== 2 : seats.length < 3) || hero === null || !seats.includes(hero)) continue;
    await library.prefetch(hand, charts);
    const analysis = analyzeHand(structuredClone(hand), { charts, turn: TURN, flopLibrary: library });
    analysed += 1;
    for (const d of analysis.decisions) {
      if (d.street === "preflop") continue;
      out.push([h, d.actionIndex, d.street, d.action, d.source, d.grade, d.evLoss === null ? null : Math.round(d.evLoss * 100) / 100]);
    }
  }
  writeFileSync(OUT, JSON.stringify(out));
  console.log(`${analysed} hands with a ${HEADS_UP ? "heads-up" : "multiway"} flop and the hero in it, ${out.length} postflop decisions (${out.filter((d) => d[5] !== null).length} graded), ${((performance.now() - started) / 1000).toFixed(0)} s`);

  if (!BEFORE || !existsSync(BEFORE)) return;
  const before = new Map((JSON.parse(readFileSync(BEFORE, "utf8")) as Graded[]).map((d) => [`${d[0]}:${d[1]}`, d]));
  const counts = new Map<string, number>();
  const bump = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1);
  const examples: string[] = [];
  for (const d of out) {
    const b = before.get(`${d[0]}:${d[1]}`);
    if (!b) continue;
    if (b[5] !== null || d[5] !== null) bump(`${d[2]} ${d[4]} graded`);
    if (b[5] === d[5]) {
      if (b[6] !== d[6] && d[5] !== null) bump(`${d[2]} ${d[4]} same grade, EV loss moved`);
      continue;
    }
    bump(`${d[2]} ${d[4]} changed`);
    bump(`${d[2]} ${d[4]} ${d[3]} ${b[5]} -> ${d[5]}`);
    if (examples.length < 12) {
      const hand = hands[d[0]];
      const ctx = buildContext(structuredClone(hand));
      const hero = heroSeatOf(ctx) as number;
      const runout = hand.board.runouts[0];
      const board = [...(runout?.flop ?? []), ...(d[2] !== "flop" && runout?.turn ? [runout.turn] : []), ...(d[2] === "river" && runout?.river ? [runout.river] : [])].join(" ");
      examples.push(`hand ${d[0]}: ${flopSeats(ctx).length}-way flop, ${board} | ${(ctx.players.get(hero)?.holeCards ?? []).join("")} ${d[2]} ${d[3]} (${d[4]}) | ${b[5]} (${b[6]}bb) -> ${d[5]} (${d[6]}bb)`);
    }
  }
  for (const [k, v] of [...counts].sort((a, b) => a[0].localeCompare(b[0]))) console.log(`  ${k}: ${v}`);
  for (const e of examples) console.log(`  example: ${e}`);
});
