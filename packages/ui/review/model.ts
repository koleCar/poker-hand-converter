/**
 * The session review's data (R5.1), as a surface hands it over.
 *
 * The screen (`SessionReviewScreen.tsx`) is the package's so the desktop app
 * can render it once it has the analysis (R5.4); today only the web does,
 * over `session_review` (`frontend/src/lib/db/sessionReview.ts`). A surface
 * implements {@link SessionReviewSource}; where the preflop deviations come
 * from is a {@link DeviationSource} of its own, so the user's own charts
 * (R5.3) can replace the shipped ones without touching the screen.
 *
 * A session is `report_sessions`' (R4.5c-1, from `stats_sessions`): the
 * hero's hands under the filter in time order across every table, a break
 * longer than the gap starting the next one.
 */
import type { HandFilter } from "../hands/model";

/** The five grades of `docs/ANALYSIS-PLAN.md` §2, best first. */
export const GRADES = ["perfect", "good", "inaccurate", "mistake", "blunder"] as const;
export type Grade = (typeof GRADES)[number];

/** How bad a grade is: perfect 1 ... blunder 5, 0 for anything else (`analysis_grade_rank`). */
export function gradeRank(grade: string | null | undefined): number {
  return grade ? GRADES.indexOf(grade as Grade) + 1 : 0;
}

/** Which session: one instant in it (`null`: the latest that has ended), the gap and the filter. */
export interface SessionQuery {
  at: string | null;
  /** Minutes; a longer break starts a new session (`report_sessions`' `p_gap_minutes`). */
  gapMinutes: number;
  /** The shared screens' filter (groups and options; never dates: a session is not cut by them). */
  filter: HandFilter;
}

/** One session's summary. Money only for one currency of cash. */
export interface ReviewSession {
  startedAt: string;
  endedAt: string;
  /** False while its last hand is within the gap of now: possibly still being played. */
  finished: boolean;
  /** An instant in the session before / after (its neighbour's nearest hand), to walk to. */
  previousAt: string | null;
  nextAt: string | null;
  hands: number;
  tables: number;
  allInHands: number;
  mixedUnitKind: boolean;
  mixedCurrency: boolean;
  /** Every hand cash (the money tiles apply). */
  cash: boolean;
  currency: string | null;
  currencySymbol: string | null;
  currencyMinorUnits: number | null;
  /** Thousandths of a big blind; null when chips mix with cash. */
  netBbMilli: number | null;
  /** The same with every all-in hand at its EV. */
  evNetBbMilli: number | null;
  /** Minor units; null unless one currency of cash. */
  net: number | null;
  evNet: number | null;
}

/** What the lists show of a hand. */
export interface ReviewHand {
  handId: string;
  playedAt: string | null;
  site: string;
  stakesLabel: string | null;
  gameFormat: string | null;
  currency: string;
  currencySymbol: string;
  minorUnits: number;
  bigBlind: number | null;
  tableName: string | null;
  position: string | null;
  heroCards: string[];
  handClass: string | null;
  board: string[];
  potType: string | null;
  potBb: number | null;
  net: number | null;
  netBbMilli: number | null;
  /** All in with cards to come: the result at its EV. */
  evNetBbMilli: number | null;
  /** The hand's worst grade and its EV loss (bb), when analysed. */
  grade: string | null;
  evLossBb: number | null;
}

/** One graded decision (a hand's worst, or its preflop deviation). */
export interface ReviewDecision {
  handId: string;
  ord: number;
  /** Where the replayer opens (`PhfAction.index`). */
  actionIndex: number;
  street: string;
  /** What the hero did. */
  action: string;
  /** The reference's best action (highest EV), when there are options. */
  best: string | null;
  scenario: string | null;
  position: string | null;
  source: string | null;
  grade: string | null;
  evLossBb: number | null;
  evLossPot: number | null;
  /** How often the reference takes the hero's action (0-1). */
  chosenFreq: number | null;
}

export interface ReviewPot {
  handId: string;
  potBb: number;
}

/** How much of the session the analysis has seen, at the client's version. */
export interface ReviewCoverage {
  hands: number;
  analysed: number;
  graded: number;
  notAnalysed: number;
}

/** What the source answers for one session. */
export interface SessionReview {
  gapMinutes: number;
  /** Null: no hand matches (an empty library, or a filter that matches nothing). */
  session: ReviewSession | null;
  /** The latest session when it may still be going on (shown, not reviewed, by default). */
  ongoing: { startedAt: string; endedAt: string } | null;
  coverage: ReviewCoverage;
  worst: ReviewDecision[];
  /** The shipped charts' deviations, as the server ranked them. */
  chartDeviations: ReviewDecision[];
  pots: ReviewPot[];
  hands: Record<string, ReviewHand>;
}

/** One row of the session picker (`report_sessions`). */
export interface SessionListItem {
  startedAt: string;
  endedAt: string;
  hands: number;
  tables: number;
  netBbMilli: number | null;
}

/** What the screen asks a surface for. */
export interface SessionReviewSource {
  /** One session and its lists, at most `limit` per list. */
  review(query: SessionQuery, limit: number): Promise<SessionReview>;
  /** Recent sessions for the picker, newest first. */
  sessions(query: SessionQuery): Promise<SessionListItem[]>;
}

/**
 * Where "deviations from the user's preflop charts" come from. Today the
 * shipped charts the analysis grades by ({@link shippedChartDeviations});
 * R5.3's own charts become another source - comparing the session's preflop
 * decisions with the user's ranges - and the screen does not change.
 */
export interface DeviationSource {
  id: string;
  deviations(review: SessionReview, query: SessionQuery): Promise<ReviewDecision[]>;
}

/**
 * The shipped charts: a preflop decision graded against them
 * (`source = 'chart'`) at Inaccurate or worse - the chart plays the hero's
 * action under 3.5 % of the time (Good or Perfect otherwise) - as the
 * review already carries them.
 */
export const shippedChartDeviations: DeviationSource = {
  id: "shipped-charts",
  deviations: (review) => Promise.resolve(review.chartDeviations),
};
