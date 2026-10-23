/**
 * The shared Reports screen's `ReportSource` (`@rail/ui/reports/model`,
 * R4.5c) over the web's report summaries (`20270707090000_report_summaries.sql`):
 * `report_open` (the summary and the rollups' breakdowns), `report_graph`,
 * `report_situations` (the breakdowns by situation) and `report_facets` (the
 * chips' counts), as the reader under RLS. The desktop app implements the
 * same interface over its local store.
 *
 * The server sends sums; every statistic the screen shows is `showStat` of
 * the shipped definitions (`STANDARD_STATS`, `config/stats/`) over them - the
 * function the desktop's Rust matches digit for digit - so the screen gets
 * the same `Shown` from either surface. Money the server withholds (chips
 * with cash; two currencies) is not a number here: a definition that reads it
 * shows no value.
 *
 * `rawTotals` keeps each report's sums for the web's own panels beside the
 * screen (the HUD tiles read counters, not `Shown`s).
 */
import type { FacetCount, HandFacets, HandFilter, SiteFacet, StakeFacet } from "@rail/ui/hands/model";
import type { Shown } from "@rail/ui/model/stats";
import {
  BREAKDOWN_COLUMNS,
  type Breakdowns,
  type Graph,
  type GraphBucket,
  type Report,
  type ReportSource,
  type StatGroup,
  type Units,
} from "@rail/ui/reports/model";
import { EV_VERSION } from "../equity";
import { getParser, unitForCode } from "../phf";
import {
  COUNTER_KEYS,
  MONEY_KEYS,
  STANDARD_STATS,
  STATS_VERSION,
  emptyCounters,
  emptyMoney,
  showStat,
  type DisplayStat,
  type DisplaySums,
  type SeatCounters,
  type SeatMoney,
} from "../stats";
import { rpc } from "./client";

/** The graph's points: the server cuts them at day ends (`report_graph`); a phone's width is ~310 px. */
export const WEB_GRAPH_POINTS = 150;

export type Row = Record<string, unknown>;

export const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))
      ? Number(value)
      : 0;
export const maybe = (row: Row, key: string): number | null => (key in row && row[key] !== null ? num(row[key]) : null);
export const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

/** The screen's filter as the readers take it (the versions the client reads). */
function wire(filter: HandFilter): Record<string, unknown> {
  return { ...filter, statsVersion: STATS_VERSION, evVersion: EV_VERSION };
}

/** The definitions the screen lists, in the shipped file's order. */
export const WEB_DEFINITIONS = STANDARD_STATS.map((stat) => stat.def);
const IDS = STANDARD_STATS.map((stat) => stat.def.id);
const COLUMNS: DisplayStat[] = BREAKDOWN_COLUMNS.map((id) => {
  const stat = STANDARD_STATS.find((candidate) => candidate.def.id === id);
  if (!stat) throw new Error(`no statistic ${JSON.stringify(id)} in the definitions`);
  return stat;
});

/** The sums a report row carries, as `showStat` reads them; money the server withheld is NaN (no value). */
export interface RawSums {
  counters: SeatCounters;
  money: SeatMoney;
  moneyHands: number;
  evNetBbMilli: number | null;
}

export function sumsOf(row: Row): RawSums {
  const counters = emptyCounters();
  for (const key of COUNTER_KEYS) counters[key] = num(row[key]);
  const money = emptyMoney();
  for (const key of MONEY_KEYS) money[key] = key in row ? num(row[key]) : Number.NaN;
  return {
    counters,
    money,
    moneyHands: num(row.money_hands),
    evNetBbMilli: maybe(row, "ev_net_bb_milli"),
  };
}

export function show(stats: readonly DisplayStat[], sums: RawSums, minorUnits: number | null): Shown[] {
  const input: DisplaySums = {
    counters: sums.counters,
    money: sums.money,
    moneyHands: sums.moneyHands,
    evNetBbMilli: sums.evNetBbMilli,
  };
  return stats.map((stat) => showStat(stat, input, minorUnits));
}

function unitsOf(payload: Row): Units {
  const currency = str(payload.currency);
  return {
    mixedKind: payload.mixedUnitKind === true,
    mixedCurrency: payload.mixedCurrency === true,
    currency,
    symbol: currency ? unitForCode(currency).symbol : null,
    minorUnits: maybe(payload, "currencyMinorUnits"),
  };
}

/** "PokerStars", not "pokerstars"; our own re-import format has no room. */
export function siteName(id: string, standardFormat: string): string {
  if (id === "standard") return standardFormat;
  return getParser(id)?.name ?? id;
}

export function groupsOf(rows: unknown, minorUnits: number | null, label?: (key: string) => string | null): StatGroup[] {
  return (Array.isArray(rows) ? (rows as Row[]) : []).map((row) => {
    const sums = sumsOf(row);
    const key = str(row.key) ?? "";
    return {
      key,
      label: label ? label(key) : null,
      hands: num(row.hands),
      moneyHands: num(row.money_hands),
      net: maybe(row, "net"),
      netBbMilli: maybe(row, "net_bb_milli"),
      stats: show(COLUMNS, sums, minorUnits),
    };
  });
}

function graphOf(payload: Row): Graph {
  const rows = Array.isArray(payload.buckets) ? (payload.buckets as Row[]) : [];
  const allInEv = payload.allInEv && typeof payload.allInEv === "object" ? (payload.allInEv as Row) : null;
  return {
    hands: num(payload.hands),
    moneyHands: num(payload.moneyHands),
    mixedUnitKind: payload.mixedUnitKind === true,
    mixedCurrency: payload.mixedCurrency === true,
    // The rebuild computes a hand's EV with its statistics; nothing waits in the background here.
    allInEv: { allInHands: allInEv ? num(allInEv.allInHands) : 0, pending: 0 },
    buckets: rows.map(
      (row): GraphBucket => ({
        bucket: num(row.bucket),
        hands: num(row.hands),
        moneyHands: num(row.money_hands),
        firstPlayedAt: str(row.first_played_at),
        lastPlayedAt: str(row.last_played_at),
        cumHands: num(row.cum_hands),
        cumMoneyHands: num(row.cum_money_hands),
        cumNetBbMilli: num(row.cum_net_bb_milli),
        cumSdBbMilli: num(row.cum_sd_bb_milli),
        cumNsdBbMilli: num(row.cum_nsd_bb_milli),
        cumEvBbMilli: num(row.cum_ev_bb_milli),
        // Absent, not zero, when the sample spans currencies.
        cumNet: maybe(row, "cum_net"),
        cumSdNet: maybe(row, "cum_sd_net"),
        cumNsdNet: maybe(row, "cum_nsd_net"),
        cumEvNet: maybe(row, "cum_ev_net"),
      }),
    ),
  };
}

/** The sums behind the last report of each filter (the web's HUD tiles beside the screen). */
const rawTotals = new WeakMap<Report, RawSums>();

/** The sums `report` was shown from, for the web's own panels. */
export function reportTotals(report: Report): RawSums | null {
  return rawTotals.get(report) ?? null;
}

/** The web's source; `standardFormat` names hands in Rail's own text format. */
export function webReportSource(standardFormat: string): ReportSource {
  return {
    async report(filter, points): Promise<Report> {
      const [open, graph] = await Promise.all([
        rpc<Row>("report_open", { p_filter: wire(filter) }),
        rpc<Row>("report_graph", { p_filter: wire(filter), p_points: Math.min(points, WEB_GRAPH_POINTS) }),
      ]);
      const units = unitsOf(open);
      const minorUnits = units.mixedCurrency || units.mixedKind ? null : units.minorUnits;
      const total = open.total && typeof open.total === "object" ? (open.total as Row) : {};
      const sums = sumsOf(total);
      const groups = open.groups && typeof open.groups === "object" ? (open.groups as Row) : {};
      const report: Report = {
        units,
        summary: {
          hands: num(open.hands),
          moneyHands: num(open.moneyHands),
          net: maybe(total, "net"),
          netBbMilli: maybe(total, "net_bb_milli"),
          evNetBbMilli: maybe(total, "ev_net_bb_milli"),
          stats: show(STANDARD_STATS, sums, minorUnits),
          ids: IDS,
        },
        graph: graphOf(graph),
        columns: [...BREAKDOWN_COLUMNS],
        byPosition: groupsOf(groups.position, minorUnits),
        byStake: groupsOf(groups.stake, minorUnits),
        bySite: groupsOf(groups.site, minorUnits, (key) => siteName(key, standardFormat)),
        bySize: groupsOf(groups.size, minorUnits),
        byFormat: groupsOf(groups.format, minorUnits),
      };
      rawTotals.set(report, sums);
      return report;
    },
    async breakdowns(filter): Promise<Breakdowns> {
      const payload = await rpc<Row>("report_situations", { p_filter: wire(filter) });
      const groups = payload.groups && typeof payload.groups === "object" ? (payload.groups as Row) : {};
      const minorUnits = null;
      return {
        columns: [...BREAKDOWN_COLUMNS],
        potType: groupsOf(groups.potType, minorUnits),
        stack: groupsOf(groups.stack, minorUnits),
        handClass: groupsOf(groups.handClass, minorUnits),
        players: groupsOf(groups.players, minorUnits),
        street: groupsOf(groups.street, minorUnits),
      };
    },
    async facets(filter): Promise<HandFacets> {
      const raw = await rpc<Row>("report_facets", { p_filter: wire(filter) });
      const list = (key: string) => (Array.isArray(raw[key]) ? (raw[key] as FacetCount[]) : []);
      const stakes = (Array.isArray(raw.stakes) ? (raw.stakes as Row[]) : []).map(
        (row): StakeFacet => {
          const currency = str(row.currency);
          return {
            value: str(row.value) ?? "",
            count: num(row.count),
            currency,
            currencySymbol: str(row.currencySymbol) ?? (currency ? unitForCode(currency).symbol : null),
            minorUnits: maybe(row, "minorUnits"),
            smallBlind: maybe(row, "smallBlind"),
            bigBlind: maybe(row, "bigBlind"),
          };
        },
      );
      return {
        total: num(raw.total),
        library: num(raw.library),
        sites: list("sites").map((f): SiteFacet => ({ ...f, name: siteName(f.value, standardFormat) })),
        formats: list("formats"),
        variants: list("variants"),
        limits: list("limits"),
        sizes: list("sizes"),
        stakes,
        positions: list("positions"),
        // Reports' chips are the groups a report sums by; the rest are the Hands screen's.
        potTypes: [],
        results: [],
        stacks: [],
        allIn: [],
        tags: [],
        noted: 0,
      };
    },
    graphPoints: WEB_GRAPH_POINTS,
  };
}
