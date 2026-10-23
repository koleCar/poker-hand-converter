/**
 * The web's `SessionReviewSource` (R5.1, `packages/ui/review/`): one
 * session's review from `session_review`, the picker's sessions from
 * `report_sessions` - the session rule the Statistics page's Sessions panel
 * uses, over the same filter.
 *
 * Versions: the statistics, the all-in EV and the analysis rows are read at
 * this build's `STATS_VERSION`, `EV_VERSION` and `ANALYSIS_VERSION` (the
 * server's default is the first of each, so the client always says).
 *
 * The picker reads the last {@link PICKER_DAYS} days only: `report_sessions`
 * numbers every session of its filter in one pass (~1 s at a million
 * hands), and a picker needs the recent ones - older sessions are a
 * "Previous session" walk away, or a link from Statistics -> Sessions. The
 * oldest session of a window may begin before it, so it is left out; with
 * fewer than two sessions in the window, the whole history is read.
 */
import type { HandFilter } from "@rail/ui/hands/model";
import type {
  ReviewDecision,
  ReviewHand,
  ReviewSession,
  SessionListItem,
  SessionQuery,
  SessionReview,
  SessionReviewSource,
} from "@rail/ui/review/model";

import { ANALYSIS_VERSION } from "../analysis/types";
import { EV_VERSION } from "../equity/allInEv";
import { STATS_VERSION } from "../stats/types";
import { currentUserId, rpc } from "./client";

type Row = Record<string, unknown>;

/** How far back the picker looks. */
export const PICKER_DAYS = 90;
/** At most this many sessions in the picker. */
export const PICKER_MAX = 60;

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))
      ? Number(value)
      : 0;
const maybeNum = (value: unknown): number | null => (value === null || value === undefined ? null : num(value));
const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const rows = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** The filter the server reads: the groups and options, never dates (a session is not cut by them). */
export function serverFilter(filter: HandFilter): HandFilter & Record<string, unknown> {
  const { from: _from, to: _to, ...rest } = filter;
  void _from;
  void _to;
  return { ...rest, statsVersion: STATS_VERSION, evVersion: EV_VERSION, analysisVersion: ANALYSIS_VERSION };
}

function decisionOf(row: Row): ReviewDecision {
  return {
    handId: String(row.handId ?? ""),
    ord: num(row.ord),
    actionIndex: num(row.actionIndex),
    street: str(row.street) ?? "",
    action: str(row.action) ?? "",
    best: str(row.best),
    scenario: str(row.scenario),
    position: str(row.position),
    source: str(row.source),
    grade: str(row.grade),
    evLossBb: maybeNum(row.evLossBb),
    evLossPot: maybeNum(row.evLossPot),
    chosenFreq: maybeNum(row.chosenFreq),
  };
}

function handOf(handId: string, row: Row): ReviewHand {
  return {
    handId,
    playedAt: str(row.playedAt),
    site: str(row.site) ?? "",
    stakesLabel: str(row.stakesLabel),
    gameFormat: str(row.gameFormat),
    currency: str(row.currency) ?? "",
    currencySymbol: str(row.currencySymbol) ?? "",
    minorUnits: num(row.minorUnits) || 1,
    bigBlind: maybeNum(row.bigBlind),
    tableName: str(row.tableName),
    position: str(row.position),
    heroCards: strings(row.heroCards),
    handClass: str(row.handClass),
    board: strings(row.board),
    potType: str(row.potType),
    potBb: maybeNum(row.potBb),
    net: maybeNum(row.net),
    netBbMilli: maybeNum(row.netBbMilli),
    evNetBbMilli: maybeNum(row.evNetBbMilli),
    grade: str(row.grade),
    evLossBb: maybeNum(row.evLossBb),
  };
}

function sessionOf(row: Row): ReviewSession {
  return {
    startedAt: str(row.startedAt) ?? "",
    endedAt: str(row.endedAt) ?? "",
    finished: row.finished === true,
    previousAt: str(row.previousAt),
    nextAt: str(row.nextAt),
    hands: num(row.hands),
    tables: num(row.tables),
    allInHands: num(row.allInHands),
    mixedUnitKind: row.mixedUnitKind === true,
    mixedCurrency: row.mixedCurrency === true,
    cash: row.cash === true,
    currency: str(row.currency),
    currencySymbol: str(row.currencySymbol),
    currencyMinorUnits: maybeNum(row.currencyMinorUnits),
    netBbMilli: maybeNum(row.netBbMilli),
    evNetBbMilli: maybeNum(row.evNetBbMilli),
    net: maybeNum(row.net),
    evNet: maybeNum(row.evNet),
  };
}

/** `session_review`'s answer as the screen's `SessionReview`. */
export function reviewFromPayload(payload: Row | null, gapMinutes: number): SessionReview {
  const session = payload?.session && typeof payload.session === "object" ? sessionOf(payload.session as Row) : null;
  const ongoing = payload?.ongoing && typeof payload.ongoing === "object" ? (payload.ongoing as Row) : null;
  const coverage = (payload?.analysis && typeof payload.analysis === "object" ? payload.analysis : {}) as Row;
  const hands = (payload?.hands && typeof payload.hands === "object" ? payload.hands : {}) as Record<string, Row>;
  return {
    gapMinutes: num(payload?.gapMinutes) || gapMinutes,
    session,
    ongoing:
      ongoing && str(ongoing.startedAt) && str(ongoing.endedAt)
        ? { startedAt: str(ongoing.startedAt) ?? "", endedAt: str(ongoing.endedAt) ?? "" }
        : null,
    coverage: {
      hands: num(coverage.hands),
      analysed: num(coverage.analysed),
      graded: num(coverage.graded),
      notAnalysed: num(coverage.notAnalysed),
    },
    worst: rows(payload?.worst).map(decisionOf),
    chartDeviations: rows(payload?.deviations).map(decisionOf),
    pots: rows(payload?.pots).map((row) => ({ handId: String(row.handId ?? ""), potBb: num(row.potBb) })),
    hands: Object.fromEntries(Object.entries(hands).map(([handId, row]) => [handId, handOf(handId, row)])),
  };
}

/** `report_sessions`' list as the picker's, newest first; a windowed list loses its oldest. */
export function sessionsFromPayload(payload: Row | null, windowed: boolean): SessionListItem[] {
  const list = rows(payload?.sessions).map((row) => ({
    startedAt: str(row.startedAt) ?? "",
    endedAt: str(row.endedAt) ?? "",
    hands: num(row.hands),
    tables: num(row.tables),
    netBbMilli: maybeNum(row.netBbMilli),
  }));
  const complete = windowed && list.length > 1 ? list.slice(0, -1) : list;
  return complete.slice(0, PICKER_MAX);
}

const EMPTY: SessionReview = {
  gapMinutes: 30,
  session: null,
  ongoing: null,
  coverage: { hands: 0, analysed: 0, graded: 0, notAnalysed: 0 },
  worst: [],
  chartDeviations: [],
  pots: [],
  hands: {},
};

export const webSessionReviewSource: SessionReviewSource = {
  async review(query: SessionQuery, limit: number): Promise<SessionReview> {
    if (!(await currentUserId())) {
      return { ...EMPTY, gapMinutes: query.gapMinutes };
    }
    const payload = await rpc<Row | null>("session_review", {
      p_filter: serverFilter(query.filter),
      p_at: query.at ?? undefined,
      p_gap_minutes: query.gapMinutes,
      p_limit: limit,
    });
    return reviewFromPayload(payload, query.gapMinutes);
  },

  async sessions(query: SessionQuery): Promise<SessionListItem[]> {
    if (!(await currentUserId())) {
      return [];
    }
    const filter = serverFilter(query.filter);
    const from = new Date(Date.now() - PICKER_DAYS * 86_400_000).toISOString();
    const recent = await rpc<Row | null>("report_sessions", {
      p_filter: { ...filter, from },
      p_gap_minutes: query.gapMinutes,
    });
    const windowed = sessionsFromPayload(recent, true);
    if (windowed.length >= 2) {
      return windowed;
    }
    const all = await rpc<Row | null>("report_sessions", { p_filter: filter, p_gap_minutes: query.gapMinutes });
    return sessionsFromPayload(all, false);
  },
};
