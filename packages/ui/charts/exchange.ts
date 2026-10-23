/**
 * Chart sets in and out as files (R5.3): Rail's own JSON, and one situation
 * at a time as range text.
 *
 * **Rail JSON** (`rail-preflop-charts`, version 1) is readable and diffable:
 * each situation's actions are range strings (`ranges.ts`' `formatRange`,
 * weights as `:0.5`), so a file can be edited by hand and every other tool's
 * range reader understands its parts.
 *
 * ```json
 * {
 *   "format": "rail-preflop-charts", "version": 1,
 *   "name": "My 6-max 100bb",
 *   "game": { "format": "cash", "tableSize": 6, "stackBb": [80, 120] },
 *   "nodes": [
 *     { "key": "rfi:CO", "raise": "22+,A2s+,K9s+,ATo+", "call": "", "allin": "", "raiseBb": 2.5 }
 *   ]
 * }
 * ```
 *
 * A situation's text import (`importNodeText`) reads one range per action
 * into a node and refuses a class whose actions add up to more than 100 %.
 */
import {
  CHART_ACTIONS,
  CLASS_COUNT,
  CLASS_NAMES,
  LIMITS,
  TABLE_SIZES,
  actionsOf,
  emptyNode,
  formatNodeKey,
  newChartSet,
  parseNodeKey,
  validateChartSet,
  type ChartActionName,
  type ChartNode,
  type ChartProblem,
  type ChartSet,
  type NodeKey,
  type TableSize,
} from "./model";
import { formatRange, parseRange, type RangeProblem } from "./ranges";

export const RAIL_CHARTS_FORMAT = "rail-preflop-charts";

export interface RailChartsJson {
  format: typeof RAIL_CHARTS_FORMAT;
  version: 1;
  name: string;
  game: { format: "cash" | "tournament"; tableSize: TableSize; stackBb: [number, number] };
  nodes: Array<{ key: string; raise: string; call: string; allin: string; raiseBb?: number }>;
}

export function exportRailJson(set: ChartSet): RailChartsJson {
  return {
    format: RAIL_CHARTS_FORMAT,
    version: 1,
    name: set.name,
    game: { format: set.gameFormat, tableSize: set.tableSize, stackBb: [set.stackMinBb, set.stackMaxBb] },
    nodes: [...set.nodes.entries()].map(([key, node]) => ({
      key,
      raise: formatRange(node.freq.raise),
      call: formatRange(node.freq.call),
      allin: formatRange(node.freq.allin),
      ...(node.raiseBb !== null ? { raiseBb: node.raiseBb } : {}),
    })),
  };
}

export function exportRailJsonText(set: ChartSet): string {
  return `${JSON.stringify(exportRailJson(set), null, 2)}\n`;
}

/** Why an import failed; `where` names the situation and action when it is one. */
export interface ImportProblem {
  code: "json" | "format" | "version" | "game" | "node-key" | "duplicate" | "range" | "over-100" | "set" | "too-big";
  where: string;
  detail: string;
}

export type ImportResult<T> = { ok: true; value: T } | { ok: false; problems: ImportProblem[] };

const rangeDetail = (problems: RangeProblem[]) =>
  problems
    .slice(0, 3)
    .map((p) => p.token)
    .join(" ");

/** The first class whose actions add up to more than 100 %, or -1. */
export function overHundred(node: ChartNode): number {
  for (let i = 0; i < CLASS_COUNT; i += 1) {
    if (node.freq.raise[i] + node.freq.call[i] + node.freq.allin[i] > 100) return i;
  }
  return -1;
}

/**
 * One situation from range text per action (an action left out or empty is
 * 0 everywhere). The key decides which actions it may have.
 */
export function importNodeText(
  key: NodeKey,
  texts: Partial<Record<ChartActionName, string>>,
  raiseBb: number | null = null,
): ImportResult<ChartNode> {
  const node = emptyNode();
  node.raiseBb = raiseBb;
  const where = formatNodeKey(key);
  const problems: ImportProblem[] = [];
  const allowed = actionsOf(key);
  for (const action of CHART_ACTIONS) {
    const text = texts[action]?.trim() ?? "";
    if (text === "") continue;
    if (!allowed.includes(action)) {
      problems.push({ code: "node-key", where: `${where} ${action}`, detail: action });
      continue;
    }
    const parsed = parseRange(text);
    if (!parsed.ok) {
      problems.push({ code: "range", where: `${where} ${action}`, detail: rangeDetail(parsed.problems) });
      continue;
    }
    node.freq[action] = parsed.percents;
  }
  if (problems.length === 0) {
    const over = overHundred(node);
    if (over >= 0) problems.push({ code: "over-100", where, detail: CLASS_NAMES[over] });
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, value: node };
}

const setProblem = (p: ChartProblem): ImportProblem => ({ code: "set", where: p.code, detail: p.detail });

/** A Rail JSON file back to a chart set (no id: importing makes a new set). */
export function importRailJson(text: string): ImportResult<ChartSet> {
  if (text.length > LIMITS.bytes * 4) return { ok: false, problems: [{ code: "too-big", where: "", detail: "" }] };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { ok: false, problems: [{ code: "json", where: "", detail: error instanceof Error ? error.message : "" }] };
  }
  const root = (data ?? {}) as Partial<RailChartsJson>;
  if (typeof data !== "object" || data === null || root.format !== RAIL_CHARTS_FORMAT) {
    return { ok: false, problems: [{ code: "format", where: "", detail: String(root.format ?? "") }] };
  }
  if (root.version !== 1) return { ok: false, problems: [{ code: "version", where: "", detail: String(root.version) }] };
  const game = root.game;
  const tableSize = Number(game?.tableSize) as TableSize;
  const stack = Array.isArray(game?.stackBb) ? game.stackBb.map(Number) : [];
  if (
    !game ||
    (game.format !== "cash" && game.format !== "tournament") ||
    !TABLE_SIZES.includes(tableSize) ||
    stack.length !== 2 ||
    !stack.every(Number.isFinite)
  ) {
    return { ok: false, problems: [{ code: "game", where: "", detail: JSON.stringify(game ?? null).slice(0, 120) }] };
  }
  const set = newChartSet({
    name: typeof root.name === "string" ? root.name.slice(0, LIMITS.name) : "",
    gameFormat: game.format,
    tableSize,
    stackMinBb: stack[0],
    stackMaxBb: stack[1],
  });
  const problems: ImportProblem[] = [];
  for (const entry of Array.isArray(root.nodes) ? root.nodes : []) {
    const keyText = typeof entry?.key === "string" ? entry.key : "";
    const key = parseNodeKey(keyText, tableSize);
    if (!key) {
      problems.push({ code: "node-key", where: keyText, detail: "" });
      continue;
    }
    const canonical = formatNodeKey(key);
    if (set.nodes.has(canonical)) {
      problems.push({ code: "duplicate", where: canonical, detail: "" });
      continue;
    }
    const raiseBb = typeof entry.raiseBb === "number" && Number.isFinite(entry.raiseBb) ? entry.raiseBb : null;
    const texts: Partial<Record<ChartActionName, string>> = {};
    for (const action of CHART_ACTIONS) {
      const value = (entry as Record<string, unknown>)[action];
      if (typeof value === "string") texts[action] = value;
    }
    const node = importNodeText(key, texts, raiseBb);
    if (!node.ok) problems.push(...node.problems);
    else set.nodes.set(canonical, node.value);
  }
  if (problems.length > 0) return { ok: false, problems };
  const invalid = validateChartSet(set).filter((p) => p.code !== "name");
  if (invalid.length > 0) return { ok: false, problems: invalid.map(setProblem) };
  return { ok: true, value: set };
}
