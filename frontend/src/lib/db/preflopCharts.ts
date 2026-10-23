/**
 * The web's sources for the user's own preflop charts (R5.3,
 * `packages/ui/charts/`, `20270811090000_preflop_charts.sql`, `20270811100000_preflop_charts_compare.sql`):
 *
 * - {@link webPreflopChartsSource}: the chart sets, read and written
 *   directly on `preflop_chart_sets` under its owner-only RLS (a `before`
 *   trigger checks the shape, the limits and the rate); the played cells
 *   and example hands from `preflop_chart_played` / `preflop_chart_examples`
 *   at this build's `ANALYSIS_VERSION`; Rail's shipped sets for "start from
 *   Rail's chart", loaded on demand (`lib/charts`' registry, one chunk per
 *   set).
 * - {@link webSessionChartsSource}: the session review's own-chart
 *   deviations (`preflop_chart_session`, `preflop_chart_review_hands`),
 *   under the review's filter.
 *
 * Nothing here grades: the comparison is `packages/ui/charts/compare.ts`'.
 */
import type { PlayedCell } from "@rail/ui/charts/compare";
import {
  fromStored,
  nodeFromMix,
  PLAYED_ACTIONS,
  toStored,
  type ChartNode,
  type ChartSet,
  type GameFormat,
  type PlayedAction,
  type StoredChartSet,
  type TableSize,
} from "@rail/ui/charts/model";
import { shippedNodeKey } from "@rail/ui/charts/nodeKey";
import type { SessionChartsSource, SessionPreflopDecision } from "@rail/ui/charts/sessionSource";
import type { ChartSummary, CompareQuery, ExampleHand, PlayedData, PreflopChartsSource, ShippedSetInfo } from "@rail/ui/charts/source";
import type { ReviewHand } from "@rail/ui/review/model";

import { ANALYSIS_VERSION } from "../analysis/types";
import { CHART_SETS, loadChartSet } from "../charts/registry";
import { requireDb, rpc } from "./client";
import { handOf, serverFilter } from "./sessionReview";

type Row = Record<string, unknown>;

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))
      ? Number(value)
      : 0;
const maybeNum = (value: unknown): number | null => (value === null || value === undefined ? null : num(value));
const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const rows = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (value: unknown): string | null => (typeof value === "string" && DAY.test(value) ? value : null);
const isAction = (value: unknown): value is PlayedAction => PLAYED_ACTIONS.includes(value as PlayedAction);
const tableOf = (value: unknown): TableSize | null => {
  const n = num(value);
  return n === 2 || n === 6 || n === 9 ? n : null;
};

const COLUMNS = "id, name, game_format, table_size, stack_min_bb, stack_max_bb, format_version, nodes, updated_at";

/** `preflop_chart_played`'s answer: `cells` are `[key, class, action, decisions, evLoss]`. */
export function playedFromPayload(payload: Row | null): PlayedData {
  const cells: PlayedCell[] = [];
  for (const cell of Array.isArray(payload?.cells) ? (payload.cells as unknown[]) : []) {
    if (!Array.isArray(cell) || cell.length < 5) continue;
    const [key, cls, action, decisions, ev] = cell as unknown[];
    if (typeof key !== "string" || !isAction(action)) continue;
    const index = num(cls);
    if (!Number.isInteger(index) || index < 0 || index > 168) continue;
    cells.push({ key, cls: index, action, decisions: num(decisions), evLossBb: num(ev) });
  }
  return {
    analysisVersion: str(payload?.analysisVersion) ?? ANALYSIS_VERSION,
    from: day(payload?.from),
    to: day(payload?.to),
    cells,
  };
}

const summaryOf = (row: Row): ChartSummary => ({
  id: String(row.id ?? ""),
  name: str(row.name) ?? "",
  gameFormat: (row.game_format === "tournament" ? "tournament" : "cash") as GameFormat,
  tableSize: tableOf(row.table_size) ?? 6,
  stackMinBb: num(row.stack_min_bb),
  stackMaxBb: num(row.stack_max_bb),
  nodes: row.nodes && typeof row.nodes === "object" ? Object.keys(row.nodes as object).length : 0,
  updatedAt: str(row.updated_at) ?? "",
});

/** A shipped set's situation: the most reached of its lines with that key, as whole percents. */
export async function shippedNodeOf(setId: string, key: string): Promise<ChartNode | null> {
  const set = await loadChartSet(setId);
  let best: { reach: number; node: ChartNode } | null = null;
  for (const node of set.nodes.values()) {
    if (shippedNodeKey(setId, node.line) !== key) continue;
    if (best && best.reach >= node.reach) continue;
    best = { reach: node.reach, node: nodeFromMix(node.options.map((o) => o.action), node.freq) };
  }
  return best?.node ?? null;
}

const SHIPPED: readonly ShippedSetInfo[] = CHART_SETS.filter((spec) => !spec.straddle).map((spec) => ({
  id: spec.id,
  tableSize: (spec.players === 2 ? 2 : spec.players === 9 ? 9 : 6) as TableSize,
  depthBb: spec.stackBb,
}));

const playedArgs = (query: CompareQuery) => ({
  p_version: ANALYSIS_VERSION,
  p_period: query.period,
  p_format: query.gameFormat,
  p_table_size: query.tableSize,
  p_min_bb: query.stackMinBb,
  p_max_bb: query.stackMaxBb,
});

export const webPreflopChartsSource: PreflopChartsSource = {
  async list() {
    const { data, error } = await requireDb()
      .from("preflop_chart_sets")
      .select(COLUMNS)
      .order("updated_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return rows(data).map(summaryOf);
  },

  async load(id: string): Promise<ChartSet> {
    const { data, error } = await requireDb().from("preflop_chart_sets").select(COLUMNS).eq("id", id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("not-found");
    return fromStored(data as unknown as StoredChartSet);
  },

  async save(set: ChartSet) {
    const stored = toStored(set);
    const fields = {
      name: stored.name,
      game_format: stored.game_format,
      table_size: stored.table_size,
      stack_min_bb: stored.stack_min_bb,
      stack_max_bb: stored.stack_max_bb,
      format_version: stored.format_version,
      nodes: stored.nodes as unknown as Record<string, never>,
    };
    const client = requireDb().from("preflop_chart_sets");
    const { data, error } =
      set.id === null
        ? await client.insert(fields).select("id, updated_at").single()
        : await client.update(fields).eq("id", set.id).select("id, updated_at").single();
    if (error) throw new Error(error.message);
    return { id: String((data as Row).id), updatedAt: str((data as Row).updated_at) };
  },

  async remove(id: string) {
    const { error } = await requireDb().from("preflop_chart_sets").delete().eq("id", id);
    if (error) throw new Error(error.message);
  },

  shippedSets: () => SHIPPED,

  shippedNode: (setId, key) => shippedNodeOf(setId, key),

  async played(query) {
    return playedFromPayload(await rpc<Row | null>("preflop_chart_played", playedArgs(query)));
  },

  async examples(query, key, cls, action, limit): Promise<ExampleHand[]> {
    const payload = await rpc<unknown>("preflop_chart_examples", {
      ...playedArgs(query),
      p_key: key,
      p_class: cls,
      p_action: action,
      p_limit: limit,
    });
    return rows(payload).map((row) => ({
      handId: String(row.handId ?? ""),
      actionIndex: num(row.actionIndex),
      playedAt: str(row.playedAt),
      heroCards: Array.isArray(row.heroCards) ? row.heroCards.filter((c): c is string => typeof c === "string") : [],
      stakesLabel: str(row.stakesLabel),
      site: str(row.site),
      evLossBb: maybeNum(row.evLossBb),
    }));
  },
};

/** `preflop_chart_session`'s rows. */
export function sessionDecisionsFromPayload(payload: unknown): SessionPreflopDecision[] {
  const out: SessionPreflopDecision[] = [];
  for (const row of rows(payload)) {
    if (!isAction(row.action)) continue;
    out.push({
      handId: String(row.handId ?? ""),
      ord: num(row.ord),
      actionIndex: num(row.actionIndex),
      playedAt: str(row.playedAt),
      key: typeof row.key === "string" ? row.key : "",
      cls: Number.isInteger(num(row.cls)) ? num(row.cls) : -1,
      action: row.action,
      scenario: str(row.scenario),
      position: str(row.position),
      gameFormat: str(row.gameFormat),
      tableSize: tableOf(row.tableSize),
      depthBandBb: maybeNum(row.depthBand),
      evLossBb: maybeNum(row.evLossBb),
    });
  }
  return out;
}

export const webSessionChartsSource: SessionChartsSource = {
  async sessionDecisions(session, query) {
    return sessionDecisionsFromPayload(
      await rpc<unknown>("preflop_chart_session", {
        p_filter: serverFilter(query.filter),
        p_from: session.startedAt,
        p_to: session.endedAt,
      }),
    );
  },
  async hands(handIds, query) {
    const payload = await rpc<Row | null>("preflop_chart_review_hands", {
      p_filter: serverFilter(query.filter),
      p_hand_ids: handIds.slice(0, 50),
    });
    const out: Record<string, ReviewHand> = {};
    for (const [id, row] of Object.entries(payload ?? {})) {
      if (row && typeof row === "object") out[id] = handOf(id, row as Row);
    }
    return out;
  },
};
