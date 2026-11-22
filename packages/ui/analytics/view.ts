/**
 * The Analytics screen's view model (docs/ANALYTICS.md Steps 4 and 5): pure
 * functions from what the sources hand over to what the screen lays out.
 * They arrange and place - the tabs, the figures row's rates, the All stats
 * rows and their order, the band track's geometry, a spot's fold / call /
 * raise bars - and never judge: the player's number, the target, the band,
 * the tone and the cost are the checker's (`checkStats`, `model/checker.ts`).
 * The words are `findings.ts`' and `strings/analytics.*.ts`'.
 *
 * - **Views.** Overview · Streets · All stats · Pool, and Breakdown (open
 *   question 1's default: today's breakdown tabs as a fifth tab). The
 *   figures row is shared by the first three.
 * - **Figures** are rates per 100 hands from the graph's end, so they and
 *   the curve agree: won, all-in EV, showdown and non-showdown, in big blinds
 *   or in the sample's money.
 * - **All stats rows**: the catalogue's stats with their checked figures,
 *   grouped by street (catalogue order) or ordered by cost (costliest
 *   first); all of them, or only those off target (`off` / `far`). Where the
 *   checker has no number for a stat (nothing analysed; the Free plan, which
 *   reads no checker), its coded twin from the player's rollups stands in:
 *   the player's number alone, no target.
 * - **Spot bars**: a spot's fold / call / raise for the player and for the
 *   target, from the stats that share the expanded stat's opportunity (the
 *   same decisions, `count` before `=>`), the rest of the bar what none of
 *   them counts.
 */

import type { HandFilter } from "../hands/model";
import type { Shown } from "../model/stats";
import type {
  Catalogue,
  CatalogueStat,
  CheckedStat,
  CheckerFinding,
  CheckerResult,
  CheckerRow,
  CheckerTone,
  CodedIn,
  StatGroupDef,
} from "../model/checker";
import type { Graph } from "../reports/model";
import type { CheckerFilters } from "./model";

/* ------------------------------------------------------------ views -- */

export const ANALYTICS_VIEWS = ["overview", "streets", "stats", "pool", "breakdown"] as const;
export type AnalyticsView = (typeof ANALYTICS_VIEWS)[number];

export function isAnalyticsView(value: string | null | undefined): value is AnalyticsView {
  return value !== null && value !== undefined && (ANALYTICS_VIEWS as readonly string[]).includes(value);
}

/** The views that carry the figures row. */
export function hasFigures(view: AnalyticsView): boolean {
  return view === "overview" || view === "streets" || view === "stats";
}

/* ---------------------------------------------------------- figures -- */

/** The figures row's rates per 100 hands; null where the sample has none. */
export interface Figures {
  hands: number;
  won: number | null;
  allInEv: number | null;
  showdown: number | null;
  nonShowdown: number | null;
}

const per100 = (amount: number | null | undefined, hands: number, scale: number): number | null =>
  amount === null || amount === undefined || hands <= 0 ? null : (amount * 100) / hands / scale;

/**
 * The figures from the graph's last point: big blinds per 100 hands (`bb`),
 * or the money per 100 money hands in units (`money`, `minorUnits` per unit).
 * `hands` is the larger of the graph's and the statistics' sample, as
 * Reports counted it.
 */
export function figuresOf(
  graph: Graph,
  statsHands: number,
  unit: "bb" | "money",
  minorUnits: number | null,
): Figures {
  const end = graph.buckets[graph.buckets.length - 1];
  const hands = Math.max(statsHands, graph.hands);
  if (!end) return { hands, won: null, allInEv: null, showdown: null, nonShowdown: null };
  const ev = graph.allInEv !== null;
  if (unit === "bb") {
    const n = end.cumHands;
    return {
      hands,
      won: per100(end.cumNetBbMilli, n, 1000),
      allInEv: ev ? per100(end.cumEvBbMilli, n, 1000) : null,
      showdown: per100(end.cumSdBbMilli, n, 1000),
      nonShowdown: per100(end.cumNsdBbMilli, n, 1000),
    };
  }
  const n = end.cumMoneyHands;
  const scale = minorUnits ?? 1;
  return {
    hands,
    won: per100(end.cumNet, n, scale),
    allInEv: ev ? per100(end.cumEvNet, n, scale) : null,
    showdown: per100(end.cumSdNet, n, scale),
    nonShowdown: per100(end.cumNsdNet, n, scale),
  };
}

/* ------------------------------------------------------------ coded -- */

/**
 * The player's coded statistics from the report's `Shown` values (by
 * definition id): made / opportunities for each catalogue stat with a coded
 * twin (`coded`), keyed by catalogue id. What the checker reads for WTSD,
 * W$SD and WWSF, and what stands in for a rate it has no number for.
 */
export function codedOf(
  catalogue: Catalogue,
  stats: readonly Shown[],
  ids: readonly string[],
): Record<string, CodedIn> {
  const out: Record<string, CodedIn> = {};
  for (const stat of catalogue.stats) {
    if (stat.kind === "share" || !stat.coded) continue;
    const shown = stats[ids.indexOf(stat.coded)];
    if (!shown || shown.value === null || shown.sample === null) continue;
    out[stat.id] = { made: Math.round((shown.value * shown.sample) / 100), opp: shown.sample };
  }
  return out;
}

/** The coded counts the checker itself reads: its `coded` stats only. */
export function codedForChecker(catalogue: Catalogue, coded: Readonly<Record<string, CodedIn>>): Record<string, CodedIn> {
  const out: Record<string, CodedIn> = {};
  for (const stat of catalogue.stats) {
    const counts = coded[stat.id];
    if (stat.kind === "coded" && counts) out[stat.id] = counts;
  }
  return out;
}

/* ---------------------------------------------------------- filters -- */

/** Filter groups the checker reads (or that change nothing about which hands are in). */
const FOLLOWED = new Set(["formats", "from", "to", "positions", "potTypes", "utcOffsetMinutes", "sort", "potUnit"]);

function isSet(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim() !== "";
  return true;
}

/**
 * The screen's filter as the checker reads it on both surfaces: the dates,
 * the kind of game (or one format), one position, one pot type. `partial`
 * when the filter sets anything else (or several positions or pot types):
 * the web hands those over as the Hands list's filter (`hands`), the
 * desktop's checker leaves them out and the screen says so.
 */
export function checkerFiltersOf(query: HandFilter): { filters: CheckerFilters; partial: boolean } {
  const filters: CheckerFilters = {};
  let partial = false;
  if (query.from) filters.from = query.from;
  if (query.to) filters.to = query.to;
  const formats = query.formats ?? [];
  if (formats.length === 1) {
    filters.gameFormat = formats[0];
  } else if (formats.length > 1) {
    const cash = formats.every((format) => format === "cash");
    const chips = formats.every((format) => format !== "cash" && format !== "");
    if (chips) filters.gameKind = "tournament";
    else if (cash) filters.gameKind = "cash";
    else partial = true;
  }
  const positions = query.positions ?? [];
  if (positions.length === 1) filters.position = positions[0];
  else if (positions.length > 1) partial = true;
  const potTypes = query.potTypes ?? [];
  if (potTypes.length === 1) filters.potType = potTypes[0];
  else if (potTypes.length > 1) partial = true;
  for (const [key, value] of Object.entries(query)) {
    if (!FOLLOWED.has(key) && isSet(value)) partial = true;
  }
  return { filters, partial };
}

/* -------------------------------------------------------- All stats -- */

export type AllStatsOrder = "street" | "cost";
export type AllStatsShow = "all" | "off";

/** Where the band and the dot sit on a row's track, percent of its width. */
export interface Track {
  bandLeft: number;
  bandWidth: number;
  /** Null without a player's number. */
  dot: number | null;
}

export interface AllStatsRow {
  kind: "stat";
  stat: CatalogueStat;
  /** The checker's figures; null on the Free plan (no checker read). */
  checked: CheckedStat | null;
  /** Percent; the checker's, else the coded twin's. */
  player: number | null;
  /** The player's number is the rollups' (no target to set it against). */
  fromRollups: boolean;
  tone: CheckerTone;
  track: Track | null;
  /** Analysed decisions (the checker's sample), else the rollups' opportunities. */
  n: number;
  /** bb/100 the gap costs, ≥ 0. */
  cost: number;
}

export interface AllStatsHead {
  kind: "street";
  street: string;
}

export type AllStatsItem = AllStatsHead | AllStatsRow;

/** Off target: what the off-target toggle keeps. */
export function isOff(tone: CheckerTone): boolean {
  return tone === "off" || tone === "far";
}

/**
 * The band track (the board's): centred on the band, wide enough for the
 * dot, never narrower than ±3 points; positions clamped to 2..98%.
 */
export function trackOf(bandLow: number | null, bandHigh: number | null, player: number | null): Track | null {
  if (bandLow === null || bandHigh === null) return null;
  const centre = (bandLow + bandHigh) / 2;
  const half = Math.max((bandHigh - bandLow) * 1.6, player === null ? 0 : Math.abs(player - centre) * 1.3, 3);
  const at = (value: number) => Math.max(2, Math.min(98, 50 + ((value - centre) / half) * 50));
  const left = at(bandLow);
  return { bandLeft: left, bandWidth: at(bandHigh) - left, dot: player === null ? null : at(player) };
}

/**
 * The All stats list. `result`: the checker's (null on the Free plan);
 * `coded`: the rollups' counts by catalogue id (`codedOf`).
 */
export function allStatsItems(
  catalogue: Catalogue,
  result: CheckerResult | null,
  coded: Readonly<Record<string, CodedIn>>,
  order: AllStatsOrder,
  show: AllStatsShow,
): AllStatsItem[] {
  const byId = new Map((result?.stats ?? []).map((stat) => [stat.id, stat]));
  const rows: AllStatsRow[] = catalogue.stats.map((stat) => {
    const checked = byId.get(stat.id) ?? null;
    const twin = coded[stat.id];
    const own = checked?.player ?? null;
    const fromRollups = own === null && twin !== undefined && twin.opp > 0;
    const player = own ?? (fromRollups && twin ? (twin.made * 100) / twin.opp : null);
    const tone: CheckerTone = checked && !fromRollups ? checked.tone : "none";
    return {
      kind: "stat",
      stat,
      checked,
      player,
      fromRollups,
      tone,
      track: checked && !fromRollups ? trackOf(checked.bandLow, checked.bandHigh, player) : null,
      n: fromRollups && twin ? twin.opp : (checked?.n ?? 0),
      cost: checked && !fromRollups && isOff(checked.tone) ? checked.cost : 0,
    };
  });
  const kept = show === "off" ? rows.filter((row) => isOff(row.tone)) : rows;
  if (order === "cost") {
    // Costliest first; equal costs keep the catalogue's order (a stable sort).
    return [...kept].sort((a, b) => b.cost - a.cost);
  }
  const items: AllStatsItem[] = [];
  let street: string | null = null;
  for (const row of kept) {
    if (row.stat.street !== street) {
      street = row.stat.street;
      items.push({ kind: "street", street });
    }
    items.push(row);
  }
  return items;
}

/* -------------------------------------------------------- spot bars -- */

/** A bar's part: an action class, `rest` = what none of the stats counts. */
export type BarAction = "fold" | "call" | "raise" | "bet" | "play" | "rest";

export interface BarPart {
  action: BarAction;
  /** Percent, 0..100. */
  value: number;
}

export interface SpotLine {
  row: CheckerRow;
  /** Null when a part has no number (no sample, or no target). */
  you: BarPart[] | null;
  target: BarPart[] | null;
}

/** The opportunity of a rate: its `count` before `=>`. */
function opportunityOf(stat: CatalogueStat): string | null {
  if (stat.kind !== "rate") return null;
  const at = stat.count.indexOf("=>");
  return (at < 0 ? stat.count : stat.count.slice(0, at)).trim();
}

/** The rates over the same decisions as `stat` (itself included), catalogue order. */
export function siblingsOf(catalogue: Catalogue, stat: CatalogueStat): CatalogueStat[] {
  const opportunity = opportunityOf(stat);
  if (opportunity === null) return [];
  return catalogue.stats.filter((other) => opportunityOf(other) === opportunity);
}

const clamp = (value: number) => Math.max(0, Math.min(100, value));

/** The bar from each class's percent: fold, call, raise in that order, the rest unnamed. */
export function barOf(values: ReadonlyMap<string, number | null>): BarPart[] | null {
  for (const value of values.values()) if (value === null) return null;
  const get = (cls: string) => values.get(cls) ?? undefined;
  const bet = get("bet");
  const vpip = get("vpip");
  const fold = get("fold");
  const raise = get("raise") ?? get("pfr");
  const call = get("call");
  let parts: BarPart[];
  if (bet !== undefined) {
    parts = [
      { action: "bet", value: bet },
      { action: "rest", value: 100 - bet },
    ];
  } else if (vpip !== undefined) {
    parts =
      raise !== undefined
        ? [
            { action: "fold", value: 100 - vpip },
            { action: "call", value: vpip - raise },
            { action: "raise", value: raise },
          ]
        : [
            { action: "fold", value: 100 - vpip },
            { action: "play", value: vpip },
          ];
  } else if (fold !== undefined && raise !== undefined) {
    parts = [
      { action: "fold", value: fold },
      { action: "call", value: 100 - fold - raise },
      { action: "raise", value: raise },
    ];
  } else if (fold !== undefined) {
    parts = [
      { action: "fold", value: fold },
      { action: "rest", value: 100 - fold },
    ];
  } else if (raise !== undefined) {
    parts = [
      { action: "rest", value: 100 - raise },
      { action: "raise", value: raise },
    ];
  } else if (call !== undefined) {
    parts = [
      { action: "call", value: call },
      { action: "rest", value: 100 - call },
    ];
  } else {
    return null;
  }
  return parts.map((part) => ({ action: part.action, value: clamp(part.value) }));
}

/**
 * The expanded stat's spots (the checker's order), each with the player's
 * and the target's bar from the stats over the same decisions.
 */
export function spotLines(catalogue: Catalogue, result: CheckerResult | null, statId: string): SpotLine[] {
  const stat = catalogue.get(statId);
  const checked = result?.stats.find((entry) => entry.id === statId);
  if (!stat || !checked || stat.kind !== "rate") return [];
  const siblings = siblingsOf(catalogue, stat).flatMap((sibling) => {
    const figures = result?.stats.find((entry) => entry.id === sibling.id);
    return sibling.kind === "rate" && figures ? [{ cls: sibling.class, spots: figures.spots }] : [];
  });
  return checked.spots.map((row) => {
    const you = new Map<string, number | null>();
    const target = new Map<string, number | null>();
    for (const sibling of siblings) {
      const same = sibling.spots.find((spot) => spot.key === row.key);
      you.set(sibling.cls, same?.player ?? null);
      target.set(sibling.cls, same?.target ?? null);
    }
    return { row, you: barOf(you), target: barOf(target) };
  });
}

/* ---------------------------------------------------------- Streets -- */

/** The Streets tab's columns, in this order (showdown has no block). */
export const STREET_COLUMNS = ["preflop", "flop", "turn", "river"] as const;

/**
 * A block's bars: `fcr` when they split the decisions into fold / call /
 * raise (or fold / play), `single` when one action stands alone (a bet, an
 * open raise), the rest of the bar empty.
 */
export type BlockBarKind = "fcr" | "single";

/** What a block or a stat says about itself: the stat, its figures, its tone. */
export interface BlockVerdict {
  /** The stat the words are about (the costliest off target, else the block's first judged one). */
  stat: CatalogueStat;
  figures: CheckedStat;
  tone: CheckerTone;
}

export interface StreetBlock {
  /** The catalogue group (`groups`). */
  group: StatGroupDef;
  /** The group's stats, catalogue order (rates, then the weak shares where the catalogue lists them). */
  stats: CatalogueStat[];
  /** The stats the bars are made of: the group's rates over the first rate's decisions. */
  barStats: CatalogueStat[];
  kind: BlockBarKind;
  /** The player's bar, from the bar stats with a number; null with none. */
  you: BarPart[] | null;
  /** The target's; null without one (the Free plan, nothing analysed, no reference). */
  target: BarPart[] | null;
  /** The bars' sample: analysed decisions, else the rollups' opportunities. */
  n: number;
  /** The player's bar is the rollups' (no target to set it against). */
  fromRollups: boolean;
  /** Where the target comes from; null without one. */
  source: "charts" | "solver" | null;
  /** The block's words; null when nothing in it was judged. */
  verdict: BlockVerdict | null;
  tone: CheckerTone;
  /** bb/100 the block's gap costs (its costliest off-target stat's; the others judge the same decisions). */
  cost: number;
  /** Rates that count every decision of the street (`any`): they overlap the street's other blocks. */
  overlaps: boolean;
}

export interface StreetColumn {
  street: (typeof STREET_COLUMNS)[number];
  blocks: StreetBlock[];
  /**
   * bb/100 the street's gaps cost: the blocks' summed, except that a block
   * over every decision of the street (preflop's VPIP / PFR) overlaps the
   * others and stands alone (the larger of it and the others' sum).
   */
  cost: number;
}

const TONE_RANK: Record<CheckerTone, number> = { far: 4, off: 3, few: 2, ok: 1, none: 0 };

/** The judgement of a set of stats: the costliest off target, else small sample, else in range. */
function verdictOf(stats: readonly CatalogueStat[], byId: ReadonlyMap<string, CheckedStat>): BlockVerdict | null {
  let best: BlockVerdict | null = null;
  for (const stat of stats) {
    const figures = byId.get(stat.id);
    if (!figures || figures.player === null) continue;
    const candidate: BlockVerdict = { stat, figures, tone: figures.tone };
    if (best === null) {
      best = candidate;
      continue;
    }
    const off = isOff(candidate.tone);
    if (off && isOff(best.tone)) {
      if (candidate.figures.cost > best.figures.cost) best = candidate;
    } else if (TONE_RANK[candidate.tone] > TONE_RANK[best.tone] && (off || !isOff(best.tone))) {
      best = candidate;
    }
  }
  return best;
}

/** The parts of a bar, the action first when it stands alone. */
function blockBar(values: ReadonlyMap<string, number | null>): BarPart[] | null {
  const parts = barOf(values);
  if (!parts) return null;
  const actions = parts.filter((part) => part.action !== "rest");
  return actions.length === 1 ? [...actions, ...parts.filter((part) => part.action === "rest")] : parts;
}

/** How many actions a bar names (its rest aside). */
const named = (parts: readonly BarPart[] | null): number => (parts ?? []).filter((part) => part.action !== "rest").length;

/** Whether a rate counts every decision of its street (`any ...`) rather than the first. */
function countsEvery(stat: CatalogueStat): boolean {
  return stat.kind === "rate" && /^\s*any\b/.test(stat.count);
}

/**
 * The Streets tab (board AN-Main, "Streets"): four columns, preflop to
 * river, of the catalogue's groups. Each block carries the player's bar over
 * the target's (fold / call / raise from the group's rates over the same
 * decisions, or one action alone), its words and its cost. `result`: the
 * checker's (null on the Free plan: the coded twins' numbers make the
 * player's bar where every part has one, and nothing is judged).
 */
export function streetColumns(
  catalogue: Catalogue,
  result: CheckerResult | null,
  coded: Readonly<Record<string, CodedIn>>,
): StreetColumn[] {
  const byId = new Map((result?.stats ?? []).map((stat) => [stat.id, stat]));
  return STREET_COLUMNS.map((street) => {
    const blocks = catalogue.file.groups
      .filter((group) => group.street === street)
      .flatMap((group): StreetBlock[] => {
        const stats = catalogue.stats.filter((stat) => stat.group === group.id);
        const first = stats.find((stat) => stat.kind === "rate");
        if (!first) return [];
        const siblings = new Set(siblingsOf(catalogue, first).map((stat) => stat.id));
        const barStats = stats.filter((stat) => siblings.has(stat.id));
        const judged = barStats.some((stat) => (byId.get(stat.id)?.n ?? 0) > 0);
        const you = new Map<string, number | null>();
        const target = new Map<string, number | null>();
        let n = 0;
        // The bars are made of the stats with a player's number (a stat without one leaves its part out).
        for (const stat of barStats) {
          if (stat.kind !== "rate") continue;
          const figures = byId.get(stat.id);
          const twin = coded[stat.id];
          if (judged) {
            if (!figures || figures.player === null) continue;
            you.set(stat.class, figures.player);
            target.set(stat.class, figures.target);
            n = Math.max(n, figures.n);
          } else if (twin && twin.opp > 0) {
            you.set(stat.class, (twin.made * 100) / twin.opp);
            n = Math.max(n, twin.opp);
          }
        }
        const youBar = blockBar(you);
        const targetBar = judged && target.size > 0 ? blockBar(target) : null;
        const verdict = verdictOf(stats, byId);
        const leadFigures = byId.get(first.id);
        return [
          {
            group,
            stats,
            barStats,
            kind: named(youBar ?? targetBar) > 1 ? "fcr" : "single",
            you: youBar,
            target: targetBar,
            n,
            fromRollups: !judged && youBar !== null,
            source: judged ? (leadFigures?.source ?? null) : null,
            verdict,
            tone: verdict?.tone ?? "none",
            cost: verdict && isOff(verdict.tone) ? verdict.figures.cost : 0,
            overlaps: barStats.some(countsEvery),
          },
        ];
      });
    const every = blocks.filter((block) => block.overlaps).reduce((most, block) => Math.max(most, block.cost), 0);
    const rest = blocks.filter((block) => !block.overlaps).reduce((sum, block) => sum + block.cost, 0);
    return { street, blocks, cost: Math.max(every, rest) };
  });
}

/** The block to open first: the costliest off target, else none. */
export function firstOpenBlock(columns: readonly StreetColumn[]): string | null {
  let best: StreetBlock | null = null;
  for (const column of columns) {
    for (const block of column.blocks) {
      if (isOff(block.tone) && (best === null || block.cost > best.cost)) best = block;
    }
  }
  return best?.group.id ?? null;
}

/**
 * An open block's stats, each with its words: the ones with a player's
 * number, catalogue order; the first one to show the spots of is the
 * block's verdict.
 */
export function blockStats(block: StreetBlock, result: CheckerResult | null): { stat: CatalogueStat; figures: CheckedStat | null }[] {
  const byId = new Map((result?.stats ?? []).map((stat) => [stat.id, stat]));
  return block.stats
    .map((stat) => ({ stat, figures: byId.get(stat.id) ?? null }))
    .filter((entry) => entry.figures !== null && entry.figures.player !== null);
}

/* --------------------------------------------------------- Overview -- */

export interface OverviewModel {
  /**
   * `findings`: cards; `clear`: nothing clearly off at this sample;
   * `unanalysed`: no analysed decision behind any stat (nothing to judge).
   */
  state: "findings" | "clear" | "unanalysed";
  /** The costliest findings, at most `max`. */
  findings: CheckerFinding[];
  /** The stats in range, catalogue order: the pills. */
  inRange: CheckedStat[];
}

/** Overview under the graph: the three costliest findings, then the stats in range. */
export function overviewOf(result: CheckerResult, max = 3): OverviewModel {
  const findings = result.findings.slice(0, max);
  const inRange = result.stats.filter((stat) => stat.tone === "ok" && stat.player !== null);
  const judged = result.stats.some((stat) => stat.n > 0 && stat.tone !== "none");
  return { state: findings.length > 0 ? "findings" : judged ? "clear" : "unanalysed", findings, inRange };
}

/**
 * The Trainer's query for a finding's "Practise this ▸" (docs/ANALYTICS.md
 * Step 9: `from=analytics&stat=…&spot=…&size=…&classes=…`): the lead stat,
 * its costliest spot and the hand class the why-sentence names. Step 9 reads
 * it; until then the Trainer opens as it is.
 */
export function practiseQuery(finding: CheckerFinding): string {
  const query = new URLSearchParams({ from: "analytics", stat: finding.lead });
  if (finding.why.spot) query.set("spot", finding.why.spot);
  if (finding.why.handClass) query.set("classes", finding.why.handClass);
  return query.toString();
}
