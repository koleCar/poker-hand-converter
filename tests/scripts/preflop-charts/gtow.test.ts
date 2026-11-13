/**
 * Rail's preflop chart sets: GTO Wizard preflop solutions, transcribed. Every
 * set in `web/src/lib/charts/data/` is written by this converter (Rail's own
 * generator, `generate.test.ts`, ships nothing since `charts/11`):
 *
 *     cd tests && GTOW_SET=<id> npx vitest run --config scripts/preflop-charts/vitest.config.ts gtow
 *     cd tests && GTOW_SET=all npx vitest run --config scripts/preflop-charts/vitest.config.ts gtow
 *
 * `GTOW_SET` picks the set from `SETS` below (its GTO Wizard game type, seats,
 * stack, ante or straddle); `all` converts every set whose capture is in the
 * folder. The capture is `~/Projects/gtow-dumps/<id>.json` (`GTOW_DIR` for
 * another folder, `GTOW_DUMP` for one file): `{ id, gametype, depth, errors,
 * dump }`, whose game type fills a row still saying `TODO` (they must agree
 * when both name one) and whose depth must be the row's. A bare dump (the
 * `dump` alone) works too, the row then naming the game type. The dump is
 * one record per decision, keyed by the
 * solution's own action path (`F-F-F-R2.5-F`): the actor's options with their
 * per-hand strategy and EV (169 each, the solution's hand order: names sorted
 * as text, `22` first), every player's range, the pot and the chips on the
 * table. A dump holding several solutions (`{ "6max-100bb": {...}, ... }`) is
 * read at the set's `part` (or `GTOW_PART`).
 *
 * After writing the JSON, add the set's line to `CHART_SETS`
 * (`web/src/lib/charts/registry.ts`) - one entry, the id, table, depth and
 * ante or straddle - and it is graded on, offered in the Solver and the
 * trainers (docs/CHARTS.md §6).
 *
 * Conversion: codes F/C/X/R<size>/all-in → f/c/k/r/a (a line is the letters of
 * its path, as in every chart set); EVs from "from the decision on" (a fold is
 * 0) to Rail's "net from the start of the hand" (minus the ante and what the
 * actor has in already); reach = the product of the actions' total frequencies
 * along the path. Seats: GTO Wizard's full-ring names `UTG1`, `UTG2` are
 * Rail's `UTG+1`, `UTG+2`; heads-up its `BTN` is Rail's `SB`.
 *
 * **Several raise sizes.** A Rail line has one raise letter per decision, so a
 * decision offering two or more raise sizes below all-in keeps them as one
 * `r` option: its frequency is their sum, its EV their frequency-weighted mean
 * per hand (the best size's where a hand never raises), its size and the
 * subtree after it the most frequent size's. The sizes merged are listed in
 * `model.merged`.
 *
 * **Partial captures.** A decision the capture could not read (one of its
 * `errors`) or had not reached yet (still in its `queue`) is absent with
 * everything after it, and its Rail line listed in `model.missing`: a
 * hand reaching it gets no chart (the lookup's `missing-node`), never
 * another set's numbers. Capture it and convert again to fill the gap.
 *
 * **Antes and straddles.** An ante set (`ante`, bb from every seat) records
 * `game.ante`; its `stackBb` is the stack at the start of the hand, ante
 * included (`100.166`: 100bb behind once the ante is in, as GTO Wizard deals
 * it). A straddle set (`straddle`) records `game.straddle` as the straddle
 * sets always have: the straddler (the first seat left of the big blind,
 * Rail's `UTG`) and its size, with `positions` in action order - starting
 * left of the straddler, ending with it.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  encodeEv,
  encodeFreq,
  encodeUnit,
  GTOW_CHARTS_VERSION,
  loadCharts,
  serializeCharts,
  type ChartAction,
  type ChartNodeJson,
  type ChartPosition,
  type ChartScenario,
  type ChartSetJson,
} from "../../../web/src/lib/charts/format";

interface DumpAct {
  code: string;
  pos: string;
  type: string;
  bs: string;
  allin: boolean;
  end: boolean;
  sd: boolean;
  ns: boolean;
  f: number;
  s: number[];
  ev: number[];
}
interface DumpNode {
  pot: string;
  active: string;
  players: { pos: string; stack: string; on: string; folded: boolean }[];
  acts: DumpAct[];
  ranges: Record<string, number[]>;
}

/** A set still waiting for its GTO Wizard capture: fill in `gametype` (and the rest) when it comes. */
const TODO = "TODO";

interface GtowSet {
  id: string;
  /** GTO Wizard's game type (the solution's `gametype`), or `TODO` until captured. */
  gametype: string;
  /** What the solution is, in words (the set's `model.source`). */
  source: string;
  /** Rail's seats in preflop action order (a straddle set: starting left of the straddler, ending with it). */
  positions: ChartPosition[];
  /** Stack at the start of the hand, ante included, bb. */
  stackBb: number;
  /** Every seat's ante, bb (0: none). */
  ante: number;
  /** A straddle set: the straddler (Rail's seat) and its size, bb. */
  straddle?: { position: ChartPosition; bb: number };
  /** The solution's seat names → Rail's, beyond the defaults (`UTG1` → `UTG+1`, `UTG2` → `UTG+2`). */
  rename?: Record<string, ChartPosition>;
  /** The key of this solution in a dump holding several (`gtow-classic-sets.json`). */
  part?: string;
}

const SIX: ChartPosition[] = ["UTG", "HJ", "CO", "BTN", "SB", "BB"];
const NINE: ChartPosition[] = ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB", "BB"];
const TWO: ChartPosition[] = ["SB", "BB"];
/** 6-max with a UTG straddle, in action order: the straddler last (the shape of every straddle set). */
const SIX_STRADDLE: ChartPosition[] = ["HJ", "CO", "BTN", "SB", "BB", "UTG"];
/** GTO Wizard's full-ring names that are not Rail's. */
const DEFAULT_RENAME: Record<string, ChartPosition> = { UTG1: "UTG+1", UTG2: "UTG+2" };
/** GTO Wizard's 1/6 bb ante (its `ante0166` game types). */
const SIXTH = 0.166;
/** An ante still to read off the solution: the 1/6 bb until then (check it when the dump comes). */
const TODO_ANTE = SIXTH;

const classic = (players: number, stackBb: number, source: string): GtowSet => ({
  id: players === 2 ? `nlhe-cash-hu-${stackBb}bb` : `nlhe-cash-${players}max-${stackBb}bb`,
  gametype: TODO,
  source,
  positions: players === 2 ? TWO : players === 9 ? NINE : SIX,
  stackBb,
  ante: 0,
  ...(players === 2 ? { rename: { BTN: "SB" } } : {}),
});
/** An ante set: `ante` bb from every seat; `stackBb` the depth behind once it is in, as GTO Wizard deals it. */
const anted = (players: 6 | 9, stackBb: number, ante: number, source: string): GtowSet => ({
  id: `nlhe-cash-${players}max-${stackBb}bb-ante`,
  gametype: TODO,
  source,
  positions: players === 9 ? NINE : SIX,
  stackBb: stackBb + ante,
  ante,
});
const SIX_CLASSIC = "Cash, Classic, 6-max, NL100 rake, with cold calls, 2.5x open, GTO 3-bet";
const SIX_ANTE = "Cash, Ante 1/6 bb, 6-max, NL100 rake, no cold calls, 2.5x open";
const HU = "Cash, Heads-up, General, NL100 rake, 2.5x open";
const NINE_ANTE = "Cash, Ante, 9-max, chip EV, button cold calls, 2.5x open";
const solution = (what: string, stackBb: number) => `GTO Wizard preflop solution, transcribed (${what}, ${stackBb}bb)`;

/**
 * Every set Rail ships, by id (the owner's list, 2026-11-13). A row whose
 * `gametype` is `TODO` is a set not captured yet - fill in the game type
 * (and check the stack, ante and seats) when its dump comes; until then it
 * is absent from `CHART_SETS`. 9-max has no 60bb set without an ante (GTO
 * Wizard solves none), and 6-max has no straddle without an ante: the
 * straddle set is GTO Wizard's "Straddle + Ante".
 */
export const SETS: Record<string, GtowSet> = Object.fromEntries(
  [
    ...[40, 60, 100, 150, 200].map((bb) => classic(6, bb, solution(SIX_CLASSIC, bb))),
    ...[40, 60, 150, 200].map((bb) => anted(6, bb, SIXTH, solution(SIX_ANTE, bb))),
    { ...anted(6, 100, SIXTH, solution(SIX_ANTE, 100)), gametype: "Cash6mSimple_6mCPante0166NCCNL100R25" },
    ...[100, 150].map((bb) => classic(2, bb, solution(HU, bb))),
    classic(9, 100, solution("Cash, Classic, 9-max, NL50 rake, with cold calls, 2.5x open", 100)),
    ...[150, 200].map((bb) => classic(9, bb, solution("Cash, Classic, 9-max, live 10% rake, with cold calls, GTO open sizes", bb))),
    // TODO: the 9-max ante's size, per seat (GTO Wizard's game type names it).
    ...[60, 100, 150, 200].map((bb) => anted(9, bb, TODO_ANTE, solution(NINE_ANTE, bb))),
    // A 2bb straddle by the first seat left of the big blind, with an ante: also read for a straddled hand without one
    // (the owner's call, 2026-11-13). TODO: GTO Wizard's name for the straddler (rename it to UTG) and the ante's size.
    {
      id: "nlhe-cash-6max-100bb-straddle",
      gametype: TODO,
      source: `${solution("Cash, Straddle + Ante, 6-max, 2bb straddle by UTG", 100)}; read for straddled hands with or without an ante`,
      positions: SIX_STRADDLE,
      stackBb: 100 + TODO_ANTE,
      ante: TODO_ANTE,
      straddle: { position: "UTG", bb: 2 },
    } satisfies GtowSet,
  ].map((set) => [set.id, set]),
);

/** Solution hand order (names sorted as text) → Rail class index (`handClasses.ts`: row * 13 + col, ace first). */
function classOrder(): number[] {
  const R = "AKQJT98765432";
  const names: { name: string; index: number }[] = [];
  for (let i = 0; i < 13; i += 1) {
    for (let j = i; j < 13; j += 1) {
      if (i === j) names.push({ name: R[i] + R[i], index: i * 13 + i });
      else {
        names.push({ name: `${R[i]}${R[j]}s`, index: i * 13 + j });
        names.push({ name: `${R[i]}${R[j]}o`, index: j * 13 + i });
      }
    }
  }
  names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return names.map((n) => n.index);
}

function letter(act: DumpAct): { code: string; action: ChartAction } {
  if (act.type === "FOLD") return { code: "f", action: "fold" };
  if (act.type === "CHECK") return { code: "k", action: "check" };
  if (act.type === "CALL") return { code: "c", action: "call" };
  if (act.allin || act.type === "ALLIN") return { code: "a", action: "allin" };
  if (act.type === "RAISE" || act.type === "BET") return { code: "r", action: "raise" };
  throw new Error(`unknown action ${act.type} (${act.code})`);
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/** A decision's options, raise sizes below all-in merged into one (see the header): the kept action and the ones folded into it. */
function groups(node: DumpNode): { act: DumpAct; merged: DumpAct[] }[] {
  const raises = node.acts.filter((a) => letter(a).code === "r");
  const main = raises.length ? raises.reduce((a, b) => (b.f > a.f ? b : a)) : null;
  const out: { act: DumpAct; merged: DumpAct[] }[] = [];
  for (const act of node.acts) {
    if (letter(act).code !== "r") out.push({ act, merged: [act] });
    else if (act === main) out.push({ act, merged: raises });
  }
  return out;
}

/** A capture's file (`~/Projects/gtow-dumps/<id>.json`): the solution and what the capture knows of it. */
interface DumpFile {
  id: string;
  gametype?: string;
  /** Stack depth in big blinds, as the capture names it. */
  depth?: number | string;
  /** Spots the capture could not read; logged, never fatal (their lines land in `model.missing`). */
  errors?: unknown[];
  /** Spots a partial capture had still to read; ignored, as `errors` (what they leave out is `model.missing`). */
  queue?: unknown[];
  dump: Record<string, DumpNode>;
}

/**
 * The one solution in a file, with its game type when the file names one:
 * a capture's wrapper (`{ id, gametype, depth, errors, dump }`), a bare dump
 * (`{ path: node }`, the root at `""`), or several bare dumps keyed by part
 * (`gtow-classic-sets.json`).
 */
function solutionOf(raw: Record<string, unknown>, part: string | undefined, id: string): { dump: Record<string, DumpNode>; file: Omit<DumpFile, "dump"> | null } {
  if ("dump" in raw && raw.dump && typeof raw.dump === "object") {
    const { dump, ...file } = raw as unknown as DumpFile;
    if (file.id && file.id !== id) throw new Error(`${id}: the file is the capture of ${file.id}`);
    return { dump, file };
  }
  if ("" in raw) return { dump: raw as Record<string, DumpNode>, file: null };
  const keys = Object.keys(raw);
  const key = part ?? (keys.length === 1 ? keys[0] : undefined);
  if (!key || !(key in raw)) throw new Error(`${id}: the dump holds ${keys.join(", ")}; name one with GTOW_PART`);
  return { dump: raw[key] as Record<string, DumpNode>, file: null };
}

/** Where the captures land, one file per set (`<id>.json`); `GTOW_DIR` to read another folder. */
const DUMP_DIR = process.env.GTOW_DIR ?? join(homedir(), "Projects", "gtow-dumps");

/**
 * Converts one set's file and writes its JSON: the game type is the row's,
 * or the capture's where the row still says `TODO` (they must agree when
 * both name one). Returns a line for the log.
 */
function convertFile(spec: GtowSet, path: string, part: string | undefined, transcribed: string): string {
  const { dump, file } = solutionOf(JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>, part, spec.id);
  const gametype = spec.gametype !== TODO ? spec.gametype : (file?.gametype ?? TODO);
  if (gametype === TODO) throw new Error(`${spec.id}: no game type - fill in its row in SETS, or capture it with one`);
  if (file?.gametype && file.gametype !== gametype) throw new Error(`${spec.id}: the row says ${gametype}, the capture ${file.gametype}`);
  const depth = file?.depth === undefined ? null : Number(file.depth);
  // GTO Wizard's depth is the stack at the start of the hand, ante included (`40.166`), like the row's `stackBb`.
  if (depth !== null && Number.isFinite(depth) && Math.abs(depth - spec.stackBb) > 1e-6) {
    throw new Error(`${spec.id}: the capture is ${depth}bb deep, the row ${spec.stackBb}bb`);
  }
  const errors = file?.errors?.length ?? 0;
  // A partial capture's gaps: the spots it could not read and those still queued (`[path, reach]`).
  const gaps = [...(file?.errors ?? []), ...(file?.queue ?? [])].map((g) => (Array.isArray(g) ? g[0] : g)).filter((g): g is string => typeof g === "string");
  const set = convertGtow({ ...spec, gametype }, dump, transcribed, gaps);
  const out = fileURLToPath(new URL(`../../../web/src/lib/charts/data/${spec.id}.json`, import.meta.url));
  writeFileSync(out, serializeCharts(set));
  const loaded = loadCharts(JSON.parse(readFileSync(out, "utf8")));
  expect(loaded.nodes.size).toBe(set.nodes.length);
  const merges = (set.model.merged as string[] | undefined)?.length ?? 0;
  const missing = (set.model.missing as string[] | undefined) ?? [];
  const gapNote = missing.length ? `, missing ${missing.map((l) => l || "(root)").join(" ")}` : "";
  return `${spec.id}: ${set.nodes.length} nodes (${Object.keys(dump).length} in the dump, ${merges} merged raises${errors ? `, ${errors} capture errors` : ""}${gapNote}) → ${out}`;
}

/** The chart set of one GTO Wizard solution (pure: the dump in, the JSON out). */
export function convertGtow(spec: GtowSet, dump: Record<string, DumpNode>, transcribed: string, gaps: readonly string[] = []): ChartSetJson {
  const rename = { ...DEFAULT_RENAME, ...spec.rename };
  const seat = (pos: string) => (rename[pos] ?? pos) as ChartPosition;
  const order = classOrder();
  const toRail = (values: number[], at = 0) => {
    const out = new Float64Array(169);
    values.forEach((v, k) => (out[order[k]] = v + at));
    return out;
  };
  const stealSeats: ChartPosition[] = spec.positions.length === 2 ? ["SB"] : ["CO", "BTN", "SB"];

  const nodes: ChartNodeJson[] = [];
  const merged: string[] = [];
  // Only the paths a merged raise keeps: from the root, through each decision's kept actions.
  const lineOf = new Map<string, string>([["", ""]]);
  const reachOf = new Map<string, number>([["", 1]]);
  const queue = [""];
  while (queue.length) {
    const key = queue.shift()!;
    const node = dump[key];
    if (!node) continue;
    const path = key === "" ? [] : key.split("-");
    const line = lineOf.get(key)!;
    const reach = reachOf.get(key)!;

    // Who did what before this decision (walked through the parents).
    const history: { pos: ChartPosition; act: DumpAct }[] = [];
    for (let k = 0; k < path.length; k += 1) {
      const at = dump[path.slice(0, k).join("-")];
      const act = at.acts.find((a) => a.code === path[k])!;
      history.push({ pos: seat(act.pos), act });
    }
    const raises = history.filter((h) => ["r", "a"].includes(letter(h.act).code));
    const lastRaise = raises[raises.length - 1];
    const limpers = history.filter((h, i) => letter(h.act).code === "c" && raises.every((r) => history.indexOf(r) > i)).map((h) => h.pos);
    const callers = lastRaise ? history.slice(history.indexOf(lastRaise) + 1).filter((h) => letter(h.act).code === "c").map((h) => h.pos) : [];
    const actor = seat(node.active);
    if (!spec.positions.includes(actor)) throw new Error(`${key}: seat ${node.active} is not one of ${spec.positions.join(", ")} (add it to rename)`);
    const voluntary = history.some((h) => h.pos === actor && letter(h.act).code !== "f");
    // By the raises faced, as the stats engine counts them (`ChartScenario`): an open jam is still an open,
    // a 5-bet or more `vs-allin`.
    let scenario: ChartScenario;
    if (raises.length === 0) scenario = limpers.length ? "vs-limp" : "rfi";
    else if (raises.length === 1) scenario = limpers.includes(actor) ? "vs-iso" : callers.length ? "squeeze" : "vs-open";
    else if (raises.length === 2) scenario = "vs-3bet";
    else if (raises.length === 3) scenario = "vs-4bet";
    else scenario = "vs-allin";

    const me = node.players.find((p) => seat(p.pos) === actor)!;
    const inBb = Number(me.on);
    const toMatch = Math.max(...node.players.map((p) => Number(p.on)));
    const sunk = inBb + spec.ante;
    const kept = groups(node);
    const options = kept.map(({ act }) => {
      const { code, action } = letter(act);
      const toBb = action === "fold" || action === "check" ? inBb : action === "call" ? toMatch : Number(act.bs);
      return { code, action, toBb: round2(toBb) };
    });
    if (new Set(options.map((o) => o.code)).size !== options.length) throw new Error(`${key}: two options share a letter`);

    const freq = new Float64Array(options.length * 169);
    const ev = new Float64Array(options.length * 169);
    kept.forEach(({ act, merged: parts }, i) => {
      const s = new Array<number>(169).fill(0);
      const e = new Array<number>(169).fill(0);
      for (let h = 0; h < 169; h += 1) {
        let w = 0;
        for (const p of parts) {
          s[h] += p.s[h];
          e[h] += p.s[h] * p.ev[h];
          w += p.s[h];
        }
        if (parts.length === 1) e[h] = parts[0].ev[h];
        else e[h] = w > 1e-9 ? e[h] / w : Math.max(...parts.map((p) => p.ev[h]));
      }
      freq.set(toRail(s), i * 169);
      ev.set(toRail(e, -sunk), i * 169);
      if (parts.length > 1) merged.push(`${line || "(root)"} ${actor}: ${parts.map((p) => `${p.bs}bb ${(p.f * 100).toFixed(1)}%`).join(" + ")} → ${act.bs}bb`);
      // The kept action's subtree, if the solution goes on after it.
      if (!(act.end || act.sd || act.ns)) {
        const child = [...path, act.code].join("-");
        lineOf.set(child, line + options[i].code);
        reachOf.set(child, reach * parts.reduce((t, p) => t + p.f, 0));
        queue.push(child);
      }
    });
    const json: ChartNodeJson = {
      line,
      actor,
      scenario,
      potBb: round2(Number(node.pot)),
      inBb: round2(inBb),
      toMatchBb: round2(toMatch),
      reach: Math.round(reach * 1e6) / 1e6,
      options,
      freq: encodeFreq(freq, options.length),
      ev: encodeEv(ev),
      range: encodeUnit(toRail(node.ranges[node.active] ?? new Array(169).fill(1))),
    };
    if (scenario === "rfi" && stealSeats.includes(actor)) json.steal = true;
    if (scenario === "vs-open" && ["SB", "BB"].includes(actor) && actor !== lastRaise!.pos && stealSeats.includes(lastRaise!.pos)) json.vsSteal = true;
    if (raises.length >= 2 && !voluntary) json.cold = true;
    if (lastRaise) json.facing = { position: lastRaise.pos, toBb: round2(Number(lastRaise.act.bs)) };
    if (callers.length) json.callers = callers;
    if (limpers.length) json.limpers = limpers;
    nodes.push(json);
  }
  nodes.sort((a, b) => a.line.length - b.line.length || (a.line < b.line ? -1 : a.line > b.line ? 1 : 0));
  // The capture's gaps (GTO Wizard paths) as Rail lines: decisions the walk reached that the dump lacks. A
  // decision below the capture's reach floor (1e-5) is not a gap: it is left out by design (`rare-line`).
  const missing = [...new Set(gaps.filter((key) => !dump[key] && lineOf.has(key)).map((key) => lineOf.get(key)!))].sort(
    (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0),
  );

  const body = JSON.stringify(nodes);
  return {
    version: GTOW_CHARTS_VERSION,
    id: spec.id,
    game: {
      variant: "holdem",
      limit: "nl",
      format: "cash",
      players: spec.positions.length,
      positions: spec.positions,
      stackBb: spec.stackBb,
      ...(spec.straddle ? { straddle: spec.straddle } : {}),
      ...(spec.ante ? { ante: spec.ante } : {}),
    },
    model: {
      source: spec.source,
      gametype: spec.gametype,
      transcribed,
      evConvention: spec.ante ? "net from the start of the hand (ante and blinds included)" : "net from the start of the hand (blinds included)",
      ...(merged.length ? { merged } : {}),
      // Not captured yet, with everything after them: a hand reaching one gets no chart (`missing-node`).
      ...(missing.length ? { missing } : {}),
      hash: createHash("sha256").update(body).digest("hex").slice(0, 8),
    },
    nodes,
  };
}

test("chart set from a GTO Wizard dump", () => {
  const which = process.env.GTOW_SET ?? "";
  const transcribed = process.env.GTOW_DATE ?? new Date().toISOString().slice(0, 10);
  if (which === "all") {
    // Every set whose capture is in the folder.
    const found = Object.values(SETS).filter((spec) => existsSync(join(DUMP_DIR, `${spec.id}.json`)));
    if (!found.length) console.log(`no captures in ${DUMP_DIR}`);
    for (const spec of found) console.log(convertFile(spec, join(DUMP_DIR, `${spec.id}.json`), spec.part, transcribed));
    return;
  }
  const spec = SETS[which];
  if (!spec) {
    console.log(`GTOW_SET not set (an id, or "all"): nothing to do. Sets: ${Object.keys(SETS).join(", ")}`);
    return;
  }
  const file = process.env.GTOW_DUMP ?? join(DUMP_DIR, `${spec.id}.json`);
  console.log(convertFile(spec, file, process.env.GTOW_PART ?? spec.part, transcribed));
});
