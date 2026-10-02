/**
 * The database side of the analysis reports (phase A3,
 * `20270111090000_analysis_reports.sql`): counts in, nothing computed.
 *
 * `analysis_node_actions` returns how often the player took each action at
 * each chart node (and with which hand classes); `lib/analysis/reports.ts`
 * turns that into "yours against the reference". `analysis_node_hands` is the
 * list behind a row: the decisions at those nodes, worst first.
 *
 * Every call says which `analysis_version` it reads, like every other
 * analysis report (`withVersion` in `analysis.ts`).
 */

import { ANALYSIS_VERSION } from "../analysis";
import type { NodeActionCount, NodeClassCount, PostflopCount } from "../analysis/reports";
import type { OptionAnalysis } from "../analysis/types";
import { currentUserId, rpc } from "./client";
import type { AnalysisFilters } from "./analysis";

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

const withVersion = (filters: AnalysisFilters): AnalysisFilters => ({ analysisVersion: ANALYSIS_VERSION, ...filters });

export interface ReportStake {
  currency: string;
  currencyMinorUnits: number;
  smallBlind: number | null;
  bigBlind: number | null;
  hands: number;
}

export interface ReportFacets {
  sites: Array<{ site: string; hands: number }>;
  stakes: ReportStake[];
  /** First and last graded hand, ISO. */
  first: string | null;
  last: string | null;
}

export interface NodeActionsReport {
  analysisVersion: string;
  /** Hands and graded chart decisions in the filtered sample. */
  hands: number;
  decisions: number;
  actions: NodeActionCount[];
  classes: NodeClassCount[];
  postflop: PostflopCount[];
  facets: ReportFacets;
}

export async function fetchNodeActions(filters: AnalysisFilters = {}): Promise<NodeActionsReport | null> {
  if (!(await currentUserId())) {
    return null;
  }
  const payload = await rpc<Row | null>("analysis_node_actions", { p_filters: withVersion(filters) });
  if (!payload) {
    return null;
  }
  const facets = (payload.facets ?? {}) as Row;
  return {
    analysisVersion: str(payload.analysisVersion) ?? ANALYSIS_VERSION,
    hands: num(payload.hands),
    decisions: num(payload.decisions),
    actions: rows(payload.actions).map((row) => ({
      set: String(row.set ?? ""),
      line: String(row.line ?? ""),
      scenario: String(row.scenario ?? ""),
      action: String(row.action ?? ""),
      decisions: num(row.decisions),
      deviations: num(row.deviations),
      evLossBb: num(row.evLossBb),
    })),
    classes: rows(payload.classes).map((row) => ({
      set: String(row.set ?? ""),
      line: String(row.line ?? ""),
      handClass: String(row.handClass ?? ""),
      action: String(row.action ?? ""),
      decisions: num(row.decisions),
    })),
    postflop: rows(payload.postflop).map((row) => ({
      street: String(row.street ?? ""),
      scenario: String(row.scenario ?? ""),
      action: String(row.action ?? ""),
      decisions: num(row.decisions),
    })),
    facets: {
      sites: rows(facets.sites).map((row) => ({ site: String(row.site ?? ""), hands: num(row.hands) })),
      stakes: rows(facets.stakes).map((row) => ({
        currency: String(row.currency ?? ""),
        currencyMinorUnits: num(row.currencyMinorUnits),
        smallBlind: maybeNum(row.smallBlind),
        bigBlind: maybeNum(row.bigBlind),
        hands: num(row.hands),
      })),
      first: str(facets.first),
      last: str(facets.last),
    },
  };
}

export const NODE_HAND_SORTS = ["ev_loss", "ev_loss_pot", "recent", "oldest"] as const;
export type NodeHandSort = (typeof NODE_HAND_SORTS)[number];

export interface NodeHandRow {
  handId: string;
  ord: number;
  actionIndex: number;
  playedAt: string | null;
  site: string;
  stakesLabel: string | null;
  position: string | null;
  heroCards: string[];
  handClass: string | null;
  set: string;
  line: string;
  scenario: string;
  /** The chart action taken (`allin` for the shove). */
  action: string;
  grade: string | null;
  evLossBb: number | null;
  evLossPot: number | null;
  inRange: number | null;
  options: OptionAnalysis[];
  chosen: number | null;
}

export interface NodeHandsPage {
  total: number;
  rows: NodeHandRow[];
}

export interface NodeHandsQuery {
  /** `<set>:<line>` keys (`nodeKey`). */
  nodes: string[];
  action?: string | null;
  /** Only decisions graded worse than Perfect. Default true. */
  deviations?: boolean;
  sort?: NodeHandSort;
  limit?: number;
  offset?: number;
}

export async function fetchNodeHands(filters: AnalysisFilters, query: NodeHandsQuery): Promise<NodeHandsPage> {
  if (query.nodes.length === 0 || !(await currentUserId())) {
    return { total: 0, rows: [] };
  }
  const payload = await rpc<Row | null>("analysis_node_hands", {
    p_filters: withVersion(filters),
    p_nodes: query.nodes,
    p_action: query.action ?? undefined,
    p_deviations: query.deviations ?? true,
    p_sort: query.sort ?? "ev_loss",
    p_limit: query.limit ?? 10,
    p_offset: query.offset ?? 0,
  });
  return {
    total: num(payload?.total),
    rows: rows(payload?.rows).map((row) => ({
      handId: String(row.handId ?? ""),
      ord: num(row.ord),
      actionIndex: num(row.actionIndex),
      playedAt: str(row.playedAt),
      site: str(row.site) ?? "",
      stakesLabel: str(row.stakesLabel),
      position: str(row.position),
      heroCards: Array.isArray(row.heroCards) ? (row.heroCards as string[]) : [],
      handClass: str(row.handClass),
      set: String(row.set ?? ""),
      line: String(row.line ?? ""),
      scenario: String(row.scenario ?? ""),
      action: String(row.action ?? ""),
      grade: str(row.grade),
      evLossBb: maybeNum(row.evLossBb),
      evLossPot: maybeNum(row.evLossPot),
      inRange: maybeNum(row.inRange),
      options: Array.isArray(row.options) ? (row.options as OptionAnalysis[]) : [],
      chosen: maybeNum(row.chosen),
    })),
  };
}
