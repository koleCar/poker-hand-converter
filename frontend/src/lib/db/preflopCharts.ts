/**
 * The web's source for the user's own preflop charts (R5.3,
 * `packages/ui/charts/`, `20270811090000_preflop_charts.sql`): the chart
 * sets, read and written directly on `preflop_chart_sets` under its
 * owner-only RLS (a `before` trigger checks the shape, the limits and the
 * rate), and Rail's shipped sets for "start from Rail's chart", loaded on
 * demand (`lib/charts`' registry, one chunk per set).
 */
import {
  fromStored,
  nodeFromMix,
  toStored,
  type ChartNode,
  type ChartSet,
  type GameFormat,
  type StoredChartSet,
  type TableSize,
} from "@rail/ui/charts/model";
import { shippedNodeKey } from "@rail/ui/charts/nodeKey";
import type { ChartSummary, PreflopChartsSource, ShippedSetInfo } from "@rail/ui/charts/source";

import { CHART_SETS, loadChartSet } from "../charts/registry";
import { requireDb } from "./client";

type Row = Record<string, unknown>;

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))
      ? Number(value)
      : 0;
const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const rows = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);
const tableOf = (value: unknown): TableSize | null => {
  const n = num(value);
  return n === 2 || n === 6 || n === 9 ? n : null;
};

const COLUMNS = "id, name, game_format, table_size, stack_min_bb, stack_max_bb, format_version, nodes, updated_at";

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
};
