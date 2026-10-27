/**
 * What the charts screens (R5.3) ask a surface for. The web implements it
 * over Supabase (`web/src/lib/db/preflopCharts.ts`); the desktop app
 * can once it has the analysis (R5.4).
 */
import type { PlayedCell } from "./compare";
import type { ChartNode, ChartSet, ChartSetMeta, GameFormat, PlayedAction, TableSize } from "./model";

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

/** Which played decisions to compare: a period counted back from the last one, and the chart's own game. */
export const COMPARE_PERIODS = ["30d", "90d", "365d", "all"] as const;
export type ComparePeriod = (typeof COMPARE_PERIODS)[number];

export interface CompareQuery {
  period: ComparePeriod;
  gameFormat: GameFormat;
  tableSize: TableSize;
  stackMinBb: number;
  stackMaxBb: number;
}

export interface PlayedData {
  analysisVersion: string;
  /** UTC days compared (inclusive); null when nothing was played in scope. */
  from: string | null;
  to: string | null;
  cells: PlayedCell[];
}

/** A hand behind a deviation, to open at the decision. */
export interface ExampleHand {
  handId: string;
  actionIndex: number;
  playedAt: string | null;
  heroCards: string[];
  stakesLabel: string | null;
  site: string | null;
  evLossBb: number | null;
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
  /** Rail's sets, for "copy from Rail's chart". */
  shippedSets(): readonly ShippedSetInfo[];
  /** A shipped set's situation as whole percents (the most reached line of that key); null when the set has none. */
  shippedNode(setId: string, key: string): Promise<ChartNode | null>;
  played(query: CompareQuery): Promise<PlayedData>;
  examples(query: CompareQuery, key: string, cls: number, action: PlayedAction, limit: number): Promise<ExampleHand[]>;
}
