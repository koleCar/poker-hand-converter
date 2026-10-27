/**
 * The Reports screen's data, as both surfaces hand it over (R4.5c).
 *
 * The screen (`ReportsScreen.tsx`) was the desktop app's (R2.7b); since
 * R4.5c the web's `/stats` renders it too. Each surface keeps its own data
 * layer and implements `ReportSource` over it: the app over its store's
 * commands (`report`, `report_breakdowns`, `hands_facets`;
 * `app/src/lib/reportSource.ts`), the web over the server summaries
 * (`report_open`, `report_graph`, `report_situations`, `report_facets`;
 * `web/src/lib/db/reportSource.ts`). The shapes are the app's store
 * DTOs (`reports::ReportDto`, `BreakdownsDto`): every statistic arrives as
 * the R2.4 `Shown` (the app's from `rail_stats`, the web's from `showStat`
 * over the summed counters - the same digits).
 */
import type { HandFacets, HandFilter, SavedFiltersSource } from "../hands/model";
import type { Shown, StatDefinition } from "../model/stats";
import type { WinrateGraphBucket, WinrateGraphData } from "../stats/WinrateGraph";

/** What a sample's money can be summed in (the web's refusals). */
export interface Units {
  /** Tournament chips with cash: no money and no big blinds. */
  mixedKind: boolean;
  /** Two currencies or more: big blinds only. */
  mixedCurrency: boolean;
  currency: string | null;
  symbol: string | null;
  /** Minor units per unit (100 for cents). */
  minorUnits: number | null;
}

/** A group of the hero's hands (a position, a stake, a pot type...). */
export interface StatGroup {
  key: string;
  /** A room's name, for the rows by room. */
  label: string | null;
  hands: number;
  moneyHands: number;
  /** Minor units; null when refused. */
  net: number | null;
  /** Thousandths of a big blind; null when refused. */
  netBbMilli: number | null;
  /** `Report.columns` (or `Breakdowns.columns`), in that order. */
  stats: Shown[];
}

/** A point of the graph: the shared graph's bucket with the money hands. */
export interface GraphBucket extends WinrateGraphBucket {
  moneyHands: number;
  cumMoneyHands: number;
}

export interface Graph extends WinrateGraphData {
  moneyHands: number;
  buckets: GraphBucket[];
  /** All-in hands in the sample, and hands still waiting for their EV (the app's background pass). */
  allInEv: { allInHands: number; pending: number };
}

/** What opening Reports shows (`reports::ReportDto`). */
export interface Report {
  units: Units;
  summary: {
    hands: number;
    moneyHands: number;
    net: number | null;
    netBbMilli: number | null;
    evNetBbMilli: number | null;
    /** Every definition the surface handed the screen, in its order. */
    stats: Shown[];
    /** The definition id of each of `stats` (match by id: a user's statistics change while the app runs). */
    ids: string[];
  };
  graph: Graph;
  /** The definition ids of every group row's `stats`. */
  columns: string[];
  byPosition: StatGroup[];
  byStake: StatGroup[];
  bySite: StatGroup[];
  bySize: StatGroup[];
  byFormat: StatGroup[];
}

/** The breakdowns by situation (`reports::BreakdownsDto`), asked for when such a tab opens. */
export interface Breakdowns {
  columns: string[];
  potType: StatGroup[];
  stack: StatGroup[];
  handClass: StatGroup[];
  players: StatGroup[];
  street: StatGroup[];
}

/** A shipped definition, or (the app's) the user's own. */
export interface Definition extends StatDefinition {
  custom?: boolean;
}

/** The statistics a breakdown row carries (definition ids): the app's `reports::BREAKDOWN_COLUMNS`. */
export const BREAKDOWN_COLUMNS = [
  "hands",
  "bb_per_100",
  "vpip",
  "pfr",
  "rfi",
  "three_bet",
  "fold_to_three_bet",
  "steal",
  "cbet_flop",
  "wtsd",
  "wsd",
] as const;

/** What the screen asks a surface for. */
export interface ReportSource {
  /** The report over a filter, with the graph in about `points` points. */
  report(filter: HandFilter, points: number): Promise<Report>;
  /** The breakdowns by situation (pot type, stack, starting hand, players, street). */
  breakdowns(filter: HandFilter): Promise<Breakdowns>;
  /** The filter chips' counts. */
  facets(filter: HandFilter): Promise<HandFacets>;
  /** New hands arrived: the screen reads everything again (throttled). Returns the unsubscribe. */
  onChanged?(listener: () => void): () => void;
  /** How many points the graph asks for: the app's store draws about one a pixel; the server cuts fewer. */
  graphPoints: number;
  savedFilters?: SavedFiltersSource;
}
