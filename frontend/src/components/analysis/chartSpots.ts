/**
 * Chart nodes as a reader names them: which scenario a node belongs to in the
 * chart browser, and the line that led to it ("CO opens and BTN 3-bets").
 *
 * Pure and language-free; the words are in `ns/analysis.*.ts` (`charts`).
 * Reads chart nodes only through `lib/charts`' public types.
 */

import { handClassOf, type ChartNode, type ChartSet } from "../../lib/charts";

/** Table order, as the chart set's line keys are written (`docs/CHARTS.md` §6). */
export const CHART_POSITIONS = ["UTG", "HJ", "CO", "BTN", "SB", "BB"] as const;

export const SPOT_CATEGORIES = ["rfi", "vs-open", "vs-3bet", "vs-4bet", "squeeze", "bvb"] as const;
export type SpotCategory = (typeof SPOT_CATEGORIES)[number];

export type StepVerb = "open" | "iso" | "limp" | "call" | "3bet" | "4bet" | "5bet" | "allin" | "check";

export interface LineStep {
  position: string;
  verb: StepVerb;
}

/**
 * The non-fold actions of a line key, by position: one letter per action in
 * turn order, folds included, so the actor of each letter is the next player
 * still able to act.
 */
export function lineSteps(line: string, positions: readonly string[] = CHART_POSITIONS): LineStep[] {
  const folded = new Set<number>();
  const allIn = new Set<number>();
  const steps: LineStep[] = [];
  let raises = 0;
  let limpers = 0;
  let facingAllIn = false;
  let seat = -1;
  for (const code of line) {
    // The next player who can still act.
    for (let tries = 0; tries < positions.length; tries += 1) {
      seat = (seat + 1) % positions.length;
      if (!folded.has(seat) && !allIn.has(seat)) break;
    }
    const position = positions[seat];
    if (code === "f") {
      folded.add(seat);
    } else if (code === "k") {
      steps.push({ position, verb: "check" });
    } else if (code === "c") {
      if (raises === 0) limpers += 1;
      if (facingAllIn) allIn.add(seat);
      steps.push({ position, verb: raises === 0 ? "limp" : "call" });
    } else if (code === "r") {
      const verb: StepVerb = raises === 0 ? (limpers > 0 ? "iso" : "open") : raises === 1 ? "3bet" : raises === 2 ? "4bet" : "5bet";
      raises += 1;
      steps.push({ position, verb });
    } else if (code === "a") {
      raises += 1;
      facingAllIn = true;
      allIn.add(seat);
      steps.push({ position, verb: "allin" });
    }
  }
  return steps;
}

/** Everyone from UTG to the button folded: a blind-versus-blind pot. */
function blindVersusBlind(node: ChartNode): boolean {
  return node.line.startsWith("ffff");
}

/** The categories a node is listed under in the browser. The SB's open is both an RFI and a BvB spot. */
export function categoriesOf(node: ChartNode): SpotCategory[] {
  if (blindVersusBlind(node)) return node.scenario === "rfi" ? ["rfi", "bvb"] : ["bvb"];
  switch (node.scenario) {
    case "rfi":
      return ["rfi"];
    case "vs-open":
      return ["vs-open"];
    case "squeeze":
      return ["squeeze"];
    case "vs-3bet":
      return ["vs-3bet"];
    case "vs-4bet":
    case "vs-allin":
      return ["vs-4bet"];
    default:
      return ["bvb"];
  }
}

/** Nodes of one category, by actor in table order, then by line. */
export function nodesIn(charts: ChartSet, category: SpotCategory): ChartNode[] {
  const out = [...charts.nodes.values()].filter((node) => categoriesOf(node).includes(category));
  return out.sort(
    (a, b) =>
      CHART_POSITIONS.indexOf(a.actor) - CHART_POSITIONS.indexOf(b.actor) ||
      a.line.length - b.line.length ||
      a.line.localeCompare(b.line),
  );
}

/* ---------------------------------------------------------------- the grid - */

export const GRID_RANKS = "AKQJT98765432";

/** The class at a 13×13 cell: pairs on the diagonal, suited above it, offsuit below. */
export function gridClass(row: number, col: number): string {
  const a = GRID_RANKS[row];
  const b = GRID_RANKS[col];
  if (row === col) return `${a}${a}`;
  return row < col ? `${a}${b}s` : `${b}${a}o`;
}

export const GRID_CELLS: ReadonlyArray<{ name: string; index: number; row: number; col: number }> = Array.from(
  { length: 169 },
  (_, i) => {
    const row = Math.floor(i / 13);
    const col = i % 13;
    const name = gridClass(row, col);
    return { name, index: handClassOf(name), row, col };
  },
);

/** Combos of a class before card removal. */
export const combosOf = (name: string) => (name.length === 2 ? 6 : name.endsWith("s") ? 4 : 12);

/** Below this a class never reaches the node (the stored range rounds to 0). */
export const OFF_RANGE_WEIGHT = 0.5 / 255;

export interface CellData {
  name: string;
  /** Per option, in the node's option order. */
  freq: number[];
  ev: number[];
  range: number;
}

export function cellData(node: ChartNode, name: string): CellData {
  const k = handClassOf(name);
  const classes = node.range.length;
  return {
    name,
    freq: node.options.map((_, a) => node.freq[a * classes + k]),
    ev: node.options.map((_, a) => node.ev[a * classes + k]),
    range: node.range[k],
  };
}

/**
 * The whole range's action totals: each class weighted by how much of it
 * reaches the node and by its combos. `combos` is the weighted count playing
 * the action.
 */
export function actionTotals(node: ChartNode): Array<{ share: number; combos: number }> {
  const classes = node.range.length;
  const totals = node.options.map(() => 0);
  let all = 0;
  for (const cell of GRID_CELLS) {
    const weight = node.range[cell.index] * combosOf(cell.name);
    all += weight;
    node.options.forEach((_, a) => {
      totals[a] += weight * node.freq[a * classes + cell.index];
    });
  }
  return totals.map((combos) => ({ share: all > 0 ? combos / all : 0, combos }));
}
