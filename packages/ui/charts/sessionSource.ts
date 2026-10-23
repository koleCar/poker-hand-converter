/**
 * The session review's second deviation source (R5.1's `DeviationSource`,
 * R5.3): the session's preflop decisions against one of the user's own
 * charts, instead of the shipped charts the analysis grades by. The shipped
 * grading is untouched - this reads the stored decisions and the user's
 * percents, and decides nothing the analysis keeps.
 *
 * A decision is listed when the chart covers it (its situation is filled in,
 * and the hand is in the chart's game: format, table size, stack depth) and
 * the chart plays the hero's action with that class under 3.5 %
 * (`compare.ts`). Ranked as the shipped list is (`rankDeviations`: the EV
 * Rail's charts put on it, then newest), one per hand, at most `limit`.
 */
import type { DeviationList, DeviationSource, ReviewDecision, ReviewHand, SessionQuery, SessionReview } from "../review/model";
import { rankDeviations } from "../review/select";
import { chartBest, chartPercent, isOnChart } from "./compare";
import type { ChartSet, GameFormat, PlayedAction, TableSize } from "./model";

/** One stored preflop decision of the session (`preflop_chart_session`). */
export interface SessionPreflopDecision {
  handId: string;
  ord: number;
  actionIndex: number;
  playedAt: string | null;
  key: string;
  cls: number;
  action: PlayedAction;
  /** The analysis' preflop scenario (`unopened`, `vs-open`, …), for the row's words. */
  scenario: string | null;
  position: string | null;
  gameFormat: string | null;
  tableSize: TableSize | null;
  /** Effective stack, big blinds (10 bb steps, the lower end). */
  depthBandBb: number | null;
  evLossBb: number | null;
}

export interface SessionChartsSource {
  /** The session's preflop decisions on the shipped tree, under the review's filter. */
  sessionDecisions(session: { startedAt: string; endedAt: string }, query: SessionQuery): Promise<SessionPreflopDecision[]>;
  /** The list's rows for hands the review does not carry. */
  hands(handIds: string[], query: SessionQuery): Promise<Record<string, ReviewHand>>;
}

const formatMatches = (chart: GameFormat, format: string | null) =>
  format === null ? true : chart === "cash" ? format === "cash" : format !== "cash";

/** Whether a decision is in the chart's game (format, table, depth in 10 bb steps). */
export function inChartScope(chart: ChartSet, d: Pick<SessionPreflopDecision, "gameFormat" | "tableSize" | "depthBandBb">): boolean {
  if (!formatMatches(chart.gameFormat, d.gameFormat)) return false;
  if (d.tableSize !== null && d.tableSize !== chart.tableSize) return false;
  if (d.depthBandBb !== null && (d.depthBandBb + 10 <= chart.stackMinBb || d.depthBandBb > chart.stackMaxBb)) return false;
  return true;
}

/** The session's decisions off the chart, as the review lists them (unranked). */
export function ownChartDecisions(chart: ChartSet, decisions: readonly SessionPreflopDecision[]): ReviewDecision[] {
  const out: ReviewDecision[] = [];
  for (const d of decisions) {
    const node = chart.nodes.get(d.key);
    if (!node || d.cls < 0 || !inChartScope(chart, d)) continue;
    const percent = chartPercent(node, d.key, d.action, d.cls);
    if (isOnChart(percent)) continue;
    out.push({
      handId: d.handId,
      ord: d.ord,
      actionIndex: d.actionIndex,
      street: "preflop",
      action: d.action,
      best: chartBest(node, d.key, d.cls),
      scenario: d.scenario,
      position: d.position,
      source: "own-chart",
      grade: null,
      evLossBb: d.evLossBb,
      evLossPot: null,
      chosenFreq: percent / 100,
    });
  }
  return out;
}

export function ownChartDeviations(source: SessionChartsSource, chart: ChartSet, limit = 20): DeviationSource {
  return {
    id: `own:${chart.id ?? "draft"}`,
    kind: "own",
    label: chart.name,
    async deviations(review: SessionReview, query: SessionQuery): Promise<DeviationList> {
      const session = review.session;
      if (!session) return { decisions: [] };
      const decisions = await source.sessionDecisions({ startedAt: session.startedAt, endedAt: session.endedAt }, query);
      const off = ownChartDecisions(chart, decisions);
      const playedAt = new Map(decisions.map((d) => [d.handId, d.playedAt]));
      // Rank with what is known of each hand (its time), then fetch the rows of those shown.
      const known: Record<string, ReviewHand> = { ...review.hands };
      const stub = (handId: string): ReviewHand => ({
        handId,
        playedAt: playedAt.get(handId) ?? null,
        site: "",
        stakesLabel: null,
        gameFormat: null,
        currency: "",
        currencySymbol: "",
        minorUnits: 0,
        bigBlind: null,
        tableName: null,
        position: null,
        heroCards: [],
        handClass: null,
        board: [],
        potType: null,
        potBb: null,
        net: null,
        netBbMilli: null,
        evNetBbMilli: null,
        grade: null,
        evLossBb: null,
      });
      const ranked = rankDeviations(
        off,
        Object.fromEntries(off.map((d) => [d.handId, known[d.handId] ?? stub(d.handId)])),
      ).slice(0, limit);
      const missing = ranked.map((d) => d.handId).filter((id) => !known[id]);
      const hands = missing.length > 0 ? await source.hands(missing, query) : {};
      return { decisions: ranked, hands };
    },
  };
}
