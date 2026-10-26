/**
 * The user's own preflop charts in the app (R5.3 in the desktop app, R5.4):
 * the shared Charts screen's `PreflopChartsSource` over the local store.
 * The sets are kept on this computer only (`chart_sets`; Q4: sync carries
 * hands and statistics), Rail's shipped sets come from the analysis' chart
 * library (the same JSON the analysis grades by), and the comparison with
 * the hands played reads the store's preflop decisions (`chart_played`,
 * `chart_examples`: the web's `preflop_chart_played` / `_examples` over the
 * store, filed by the analysis runner as the web's triggers file them).
 */
import { fromStored, nodeFromMix, toStored, type ChartNode, type StoredChartSet, type TableSize } from "@rail/ui/charts/model";
import { shippedNodeKey } from "@rail/ui/charts/nodeKey";
import type { CompareQuery, ExampleHand, PreflopChartsSource, ShippedSetInfo } from "@rail/ui/charts/source";
import { stakes } from "@rail/ui/hands/format";

import { ANALYSIS_VERSION, CHART_SETS, loadChartSet } from "../analysis/library";
import { ipc, type StoredChartSetDto } from "./ipc";

/** A shipped set's situation: the most reached of its lines with that key, as whole percents (the web's `shippedNodeOf`). */
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

const compareArgs = (query: CompareQuery) => ({
  period: query.period,
  gameFormat: query.gameFormat,
  tableSize: query.tableSize,
  stackMinBb: Math.floor(query.stackMinBb),
  stackMaxBb: Math.ceil(query.stackMaxBb),
});

export const storeChartsSource: PreflopChartsSource = {
  async list() {
    const rows = await ipc.chartSetsList();
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      gameFormat: row.gameFormat,
      tableSize: (row.tableSize === 2 || row.tableSize === 9 ? row.tableSize : 6) as TableSize,
      stackMinBb: row.stackMinBb,
      stackMaxBb: row.stackMaxBb,
      nodes: row.nodes,
      updatedAt: new Date(row.updatedAt).toISOString(),
    }));
  },

  async load(id) {
    const row = await ipc.chartSetLoad(id);
    if (!row) throw new Error("not-found");
    return fromStored(row as unknown as StoredChartSet);
  },

  async save(set) {
    const stored = toStored(set);
    const saved = await ipc.chartSetSave(stored as unknown as StoredChartSetDto);
    return { id: saved.id, updatedAt: saved.updatedAt };
  },

  async remove(id) {
    await ipc.chartSetDelete(id);
  },

  shippedSets: () => SHIPPED,

  shippedNode: (setId, key) => shippedNodeOf(setId, key),

  async played(query) {
    const played = await ipc.chartPlayed(ANALYSIS_VERSION, compareArgs(query));
    return { analysisVersion: ANALYSIS_VERSION, from: played.from, to: played.to, cells: played.cells };
  },

  async examples(query, key, cls, action, limit): Promise<ExampleHand[]> {
    const rows = await ipc.chartExamples(ANALYSIS_VERSION, compareArgs(query), key, cls, action, limit);
    return rows.map((row) => ({
      handId: row.handId,
      actionIndex: row.actionIndex,
      playedAt: row.playedAt || null,
      heroCards: row.heroCards,
      stakesLabel: stakes(row),
      site: row.site,
      evLossBb: row.evLossBb,
    }));
  },
};
