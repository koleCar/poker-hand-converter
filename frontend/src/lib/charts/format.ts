/**
 * The chart set: what is stored, how it is encoded, how it is read back.
 *
 * A chart set is one JSON document per game (`data/*.json`). It carries
 *
 * - `model`: every assumption the numbers depend on - sizes, tree cuts, rake,
 *   the realisation model's constants, the equity sample, the solver and its
 *   iteration count, and the convergence it reached. A grade shown from these
 *   charts can always say what it was graded against.
 * - `nodes`: one per decision point of the tree that is reached often enough
 *   to keep (see `generate.ts`), keyed by its line (`lib/solver/preflopTree.ts`):
 *   who acts, the scenario in the stats engine's vocabulary, the options, and
 *   per option and per hand class a frequency and an EV.
 *
 * **Encoding.** Per-class arrays are base64 strings, `[action * 169 + class]`:
 *
 * - `freq`: uint8, `/ 255`. Rounded per class so the actions sum to exactly 255,
 *   i.e. frequencies sum to 1. Resolution ~0.4%, well inside the 3.5% and 5%
 *   bands grading uses.
 * - `ev`: int16 little-endian, in hundredths of a big blind. EV is net chips
 *   from the start of the hand (a fold in the big blind is -1.00), so EV loss
 *   is a plain difference between two options.
 * - `range`: uint8, `/ 255`, one per class: the probability that the actor
 *   holds that class here given how it got here (1 = every combo of it).
 *
 * `CHARTS_VERSION` changes with the format, the model or the library:
 * `charts/1` was the hand-set realisation model, `charts/2` (same format) the
 * one fitted to the postflop solver (docs/CHARTS.md §4), `charts/3` the
 * library of sets (9-max, 40-200bb; `registry.ts`), `charts/4` the limp
 * trees (open limps and over-limps from every seat, A2d). Each set carries the
 * version of the generator that made it and its own `id`. A regenerated set
 * with new numbers changes `model.hash`, and the analysis version
 * (`ANALYSIS_VERSION`) is what tells stored grades apart.
 */

import { NUM_CLASSES } from "../solver/handClasses";
import { decodeBase64, encodeBase64 } from "./base64";

export const CHARTS_VERSION = "charts/4";

/**
 * Versions a chart set file may carry. Each set records the generator that
 * made it: the 6-max 100bb set is still `charts/2`'s; the sets added in A2c
 * (9-max, other depths) are `charts/3`'s - the same model, measured at their
 * own table and depth. `CHARTS_VERSION` names the library (`registry.ts`).
 */
export const CHART_SET_VERSIONS: readonly string[] = ["charts/2", "charts/3", "charts/4"];

/** Seat names as the stats engine assigns them (`positionRing`), 6-max or 9-max. */
export type ChartPosition = "UTG" | "UTG+1" | "UTG+2" | "LJ" | "HJ" | "CO" | "BTN" | "SB" | "BB";
export type ChartAction = "fold" | "check" | "call" | "raise" | "allin";

/**
 * The decision a node is, named after the stats engine's counters
 * (`lib/stats/preflop.ts`) so a chart frequency and a player's stat line up:
 *
 * | Scenario | Spot | Stats counter |
 * |---|---|---|
 * | `rfi` | unopened pot (SB: limp or raise) | `rfi_opp`, `steal_opp` from CO/BTN/SB |
 * | `vs-limp` | one or more limpers, no raise (the BB after the SB completes; anyone behind an open limp) | `iso_opp` |
 * | `vs-open` | one raise, no callers | `three_bet_opp`, `fold_to_steal_opp` for a blind vs CO/BTN/SB |
 * | `squeeze` | one raise and one or more callers | `three_bet_opp`, `squeeze_opp` |
 * | `vs-iso` | a limper facing the isolation raise (the SB after the BB's raise of its limp) | `three_bet_opp` |
 * | `vs-3bet` | two raises | `four_bet_opp`, `fold_to_three_bet_opp` for the opener |
 * | `vs-4bet` | three raises | `five_bet_opp`, `fold_to_four_bet_opp` for the 3-bettor |
 * | `vs-allin` | a 5-bet all-in | — |
 */
export type ChartScenario =
  | "rfi"
  | "vs-limp"
  | "vs-open"
  | "squeeze"
  | "vs-iso"
  | "vs-3bet"
  | "vs-4bet"
  | "vs-allin";

export interface ChartOptionJson {
  /** Tree code: `f`, `k`, `c`, `r`, `a`. */
  code: string;
  action: ChartAction;
  /** What the actor has in after this action, bb (fold/check: what it already had). */
  toBb: number;
}

export interface ChartNodeJson {
  line: string;
  actor: ChartPosition;
  scenario: ChartScenario;
  /** RFI from CO/BTN/SB with only the blinds behind. */
  steal?: boolean;
  /** A blind facing an unraised steal. */
  vsSteal?: boolean;
  /** Facing a re-raise without having put money in voluntarily. */
  cold?: boolean;
  /** The last raiser and its size, if any. */
  facing?: { position: ChartPosition; toBb: number };
  /** Callers of the current raise so far. */
  callers?: ChartPosition[];
  /** Players who limped before the first raise (`charts/4`; the small blind's completion included). */
  limpers?: ChartPosition[];
  potBb: number;
  /** Chips the actor has in already. */
  inBb: number;
  /** Bet to match. */
  toMatchBb: number;
  /** Probability that a hand reaches this node at all, under the charts. */
  reach: number;
  /** Options removed from the tree here (see `preflopTree.ts`). */
  cut?: ("multiway-call" | "cold-call" | "limp" | "limpers-cap")[];
  options: ChartOptionJson[];
  freq: string;
  ev: string;
  range: string;
}

export interface ChartSetJson {
  /** The generator version that made this set (`CHART_SET_VERSIONS`). */
  version: string;
  /** Stable name, e.g. `nlhe-cash-6max-100bb`. */
  id: string;
  game: {
    variant: "holdem";
    limit: "nl";
    format: "cash";
    players: number;
    positions: ChartPosition[];
    stackBb: number;
  };
  /** Every assumption and the measured convergence; free-form but stable. */
  model: Record<string, unknown> & { hash: string };
  nodes: ChartNodeJson[];
}

/** A decoded node. */
export interface ChartNode {
  readonly line: string;
  /** The seats of the node's set, in table order (the actor of each line letter follows from them). */
  readonly seats: readonly ChartPosition[];
  readonly actor: ChartPosition;
  readonly scenario: ChartScenario;
  readonly steal: boolean;
  readonly vsSteal: boolean;
  readonly cold: boolean;
  readonly facing: { position: ChartPosition; toBb: number } | null;
  readonly callers: readonly ChartPosition[];
  readonly limpers: readonly ChartPosition[];
  readonly potBb: number;
  readonly inBb: number;
  readonly toMatchBb: number;
  readonly reach: number;
  readonly cut: readonly string[];
  readonly options: readonly ChartOptionJson[];
  /** `[action * 169 + class]`, sums to 1 per class. */
  readonly freq: Float64Array;
  /** `[action * 169 + class]`, bb. */
  readonly ev: Float64Array;
  /** Per class, 0..1. */
  readonly range: Float64Array;
}

export interface ChartSet {
  readonly version: string;
  readonly id: string;
  readonly game: ChartSetJson["game"];
  readonly model: ChartSetJson["model"];
  readonly nodes: ReadonlyMap<string, ChartNode>;
}

export class ChartFormatError extends Error {}

/**
 * Whether a seat other than the blinds limped on the node's line (`charts/4`):
 * the node is in a limped pot, reached through the limp's tremble - facing
 * the limpers, a limper facing the isolation raise, or anything after it. The
 * blinds' own limped pot (the small blind completes) is not one: it is
 * blind-versus-blind play the equilibrium reaches.
 */
export function isOpenLimpNode(node: Pick<ChartNode, "limpers">): boolean {
  return node.limpers.some((position) => position !== "SB" && position !== "BB");
}

/* ------------------------------------------------------------ encode - */

/** Frequencies to uint8 with each class's actions summing to exactly 255. */
export function encodeFreq(freq: ArrayLike<number>, actions: number): string {
  const bytes = new Uint8Array(actions * NUM_CLASSES);
  for (let i = 0; i < NUM_CLASSES; i += 1) {
    // Largest remainder: floor everything, hand the leftover units to the
    // largest fractional parts (ties to the lower action index).
    let used = 0;
    const rem: { a: number; r: number }[] = [];
    for (let a = 0; a < actions; a += 1) {
      const x = Math.max(0, freq[a * NUM_CLASSES + i]) * 255;
      const f = Math.floor(x + 1e-9);
      bytes[a * NUM_CLASSES + i] = f;
      used += f;
      rem.push({ a, r: x - f });
    }
    rem.sort((p, q) => q.r - p.r || p.a - q.a);
    for (let k = 0; used < 255 && k < rem.length * 255; k += 1) {
      bytes[rem[k % rem.length].a * NUM_CLASSES + i] += 1;
      used += 1;
    }
  }
  return encodeBase64(bytes);
}

/** EVs in bb to int16 hundredths. */
export function encodeEv(ev: ArrayLike<number>): string {
  const bytes = new Uint8Array(ev.length * 2);
  const view = new DataView(bytes.buffer);
  for (let k = 0; k < ev.length; k += 1) {
    const v = Math.round(ev[k] * 100);
    view.setInt16(k * 2, Math.max(-32768, Math.min(32767, v)), true);
  }
  return encodeBase64(bytes);
}

/** 0..1 values to uint8. */
export function encodeUnit(values: ArrayLike<number>): string {
  const bytes = new Uint8Array(values.length);
  for (let k = 0; k < values.length; k += 1) {
    bytes[k] = Math.round(Math.max(0, Math.min(1, values[k])) * 255);
  }
  return encodeBase64(bytes);
}

/* ------------------------------------------------------------ decode - */

function decodeNode(json: ChartNodeJson, seats: readonly ChartPosition[]): ChartNode {
  const actions = json.options.length;
  const freqBytes = decodeBase64(json.freq);
  const evBytes = decodeBase64(json.ev);
  const rangeBytes = decodeBase64(json.range);
  if (
    freqBytes.length !== actions * NUM_CLASSES ||
    evBytes.length !== actions * NUM_CLASSES * 2 ||
    rangeBytes.length !== NUM_CLASSES
  ) {
    throw new ChartFormatError(`node ${JSON.stringify(json.line)}: arrays do not match ${actions} options`);
  }
  const freq = Float64Array.from(freqBytes, (b) => b / 255);
  const view = new DataView(evBytes.buffer, evBytes.byteOffset, evBytes.byteLength);
  const ev = new Float64Array(actions * NUM_CLASSES);
  for (let k = 0; k < ev.length; k += 1) {
    ev[k] = view.getInt16(k * 2, true) / 100;
  }
  return {
    line: json.line,
    seats,
    actor: json.actor,
    scenario: json.scenario,
    steal: json.steal ?? false,
    vsSteal: json.vsSteal ?? false,
    cold: json.cold ?? false,
    facing: json.facing ?? null,
    callers: json.callers ?? [],
    limpers: json.limpers ?? [],
    potBb: json.potBb,
    inBb: json.inBb,
    toMatchBb: json.toMatchBb,
    reach: json.reach,
    cut: json.cut ?? [],
    options: json.options,
    freq,
    ev,
    range: Float64Array.from(rangeBytes, (b) => b / 255),
  };
}

/** Reads a chart set, checking the version and every array's length. */
export function loadCharts(json: unknown): ChartSet {
  const data = json as ChartSetJson;
  if (!data || typeof data !== "object" || !CHART_SET_VERSIONS.includes(data.version)) {
    throw new ChartFormatError(
      `not a ${CHART_SET_VERSIONS.join(" / ")} chart set (got ${String((data as { version?: unknown })?.version)})`,
    );
  }
  if (!Array.isArray(data.nodes)) {
    throw new ChartFormatError("chart set has no nodes");
  }
  const nodes = new Map<string, ChartNode>();
  for (const node of data.nodes) {
    nodes.set(node.line, decodeNode(node, data.game.positions));
  }
  return { version: data.version, id: data.id, game: data.game, model: data.model, nodes };
}

/**
 * The committed text form: the header pretty-printed, one node per line, so a
 * regenerated set diffs node by node. Deterministic for a given object.
 */
export function serializeCharts(set: ChartSetJson): string {
  const { nodes, ...head } = set;
  const header = JSON.stringify(head, null, 2);
  const body = nodes.map((node) => "    " + JSON.stringify(node)).join(",\n");
  return `${header.slice(0, -2)},\n  "nodes": [\n${body}\n  ]\n}\n`;
}
