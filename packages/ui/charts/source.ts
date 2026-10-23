/**
 * What the charts screens (R5.3) ask a surface for. The web implements it
 * over Supabase (`frontend/src/lib/db/preflopCharts.ts`); the desktop app
 * can once it has the analysis (R5.4).
 */
import type { ChartNode, ChartSet, ChartSetMeta, GameFormat, TableSize } from "./model";

export interface ChartSummary {
  id: string;
  name: string;
  gameFormat: GameFormat;
  tableSize: TableSize;
  stackMinBb: number;
  stackMaxBb: number;
  /** Situations filled in. */
  nodes: number;
  updatedAt: string;
}

/** One of Rail's shipped sets a situation can be copied from. */
export interface ShippedSetInfo {
  id: string;
  tableSize: TableSize;
  depthBb: number;
}

export interface PreflopChartsSource {
  list(): Promise<ChartSummary[]>;
  load(id: string): Promise<ChartSet>;
  /** Insert (no id) or update; the saved row's id and time. */
  save(set: ChartSet): Promise<Pick<ChartSetMeta, "id" | "updatedAt">>;
  remove(id: string): Promise<void>;
  /** Rail's sets, for "start from Rail's chart". */
  shippedSets(): readonly ShippedSetInfo[];
  /** A shipped set's situation as whole percents (the most reached line of that key); null when the set has none. */
  shippedNode(setId: string, key: string): Promise<ChartNode | null>;
}
