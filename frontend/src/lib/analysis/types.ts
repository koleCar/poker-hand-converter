/**
 * Hand analysis — the type system. `docs/ANALYSIS-PLAN.md` §1 is the source;
 * this file is that sketch made exact, plus what phase A1 learned it needed.
 *
 * One record per hero decision (`DecisionAnalysis`), one per hand
 * (`HandAnalysis`). The decision record has two halves that phase A1 fills very
 * differently:
 *
 * - **The grade half** — `options`, `chosen`, `evLoss`, `freqDiff`, `grade`,
 *   `score`. These need a reference strategy (preflop charts in A2, the solver
 *   from A4), so in A1 they are empty or null on every decision. The shape is
 *   final, so A2 fills it without a migration; `grading.ts` already holds the
 *   thresholds and the function that turns options into a grade.
 * - **The explanation half** — `facts` and `flags`. Computable now, from the
 *   hand alone: board texture, hand class, pot geometry, and the heuristic
 *   checks of §3.6 that are true regardless of strategy.
 *
 * **Flags are not grades.** A flag says "folding here gave up a pot you could
 * not lose", never "this was a Blunder": its severity is capped at
 * `inaccurate` by construction (`FlagSeverity` has no worse member) and the UI
 * renders flags as notes. That is §3.6's rule, enforced by the type.
 */

import type { Position, Street } from "../phf/types";

/**
 * Stamped on every stored row. Bumped when anything that changes a stored value
 * changes: a threshold in `grading.ts`, a flag's rule, a default range, a fact's
 * definition. Rows under two versions are never mixed in one report; the
 * rebuild re-derives on a bump, the same contract `STATS_VERSION` has.
 *
 *   analysis/1  A1: decision walk, facts, heuristic flags. No reference
 *               strategy, so no grades.
 */
export const ANALYSIS_VERSION = "analysis/1" as const;
export type AnalysisVersion = typeof ANALYSIS_VERSION;

/** The four streets a decision can be made on. */
export type DecisionStreet = Exclude<Street, "showdown">;
export type DecisionAction = "fold" | "check" | "call" | "bet" | "raise";

/* ---------------------------------------------------------------- grades - */

/** §2. Ordered best to worst; `GRADES.indexOf` is the severity. */
export const GRADES = ["perfect", "good", "inaccurate", "mistake", "blunder"] as const;
export type Grade = (typeof GRADES)[number];

/** Where a decision's reference came from. Always shown next to the grade. */
export type AnalysisSource = "chart" | "solver" | "heuristic";

/** One option at a node, as the reference strategy plays it (§1). */
export interface OptionAnalysis {
  action: DecisionAction;
  /** Big blinds, as solved (bucketed, §3.3). */
  size?: number;
  /** Fraction of the pot. */
  sizePot?: number;
  /** Reference frequency for the hero's exact hand, 0–1. */
  freq: number;
  /** EV for the hero's exact hand, in big blinds. */
  ev: number;
}

/* ----------------------------------------------------------------- flags - */

/**
 * The heuristic checks of §3.6. Each one is a statement about this decision
 * that holds whatever strategy the reference would play.
 *
 * - `fold-nuts`          folded a hand that cannot lose to anything the
 *                        opponent can hold.
 * - `free-fold`          folded when checking cost nothing.
 * - `call-beats-nothing` called the river with a hand that beats nothing in
 *                        the opponent's range.
 * - `call-without-odds`  called with no more cards to come (river, or an
 *                        all-in) holding much less equity than the price.
 * - `fold-with-odds`     folded with no more cards to come holding much more
 *                        equity than the price.
 * - `check-back-nuts`    closed the river by checking the nuts. River only, a
 *                        note at most: there can be a blocker or merge reason.
 * - `thin-stack-behind`  bet or raised, not all-in, leaving a stack so small
 *                        against the pot that it is committed anyway.
 * - `committed-fold`     folded after putting most of the stack in, to a price
 *                        that needed very little equity.
 */
export const FLAG_CODES = [
  "fold-nuts",
  "free-fold",
  "call-beats-nothing",
  "call-without-odds",
  "fold-with-odds",
  "check-back-nuts",
  "thin-stack-behind",
  "committed-fold",
] as const;
export type FlagCode = (typeof FLAG_CODES)[number];

/**
 * How loudly a flag speaks. `note` is context worth reading; `inaccurate` is
 * the ceiling §3.6 allows a heuristic — there is deliberately no worse member.
 */
export const FLAG_SEVERITIES = ["note", "inaccurate"] as const;
export type FlagSeverity = (typeof FLAG_SEVERITIES)[number];

export interface Flag {
  code: FlagCode;
  severity: FlagSeverity;
  /**
   * The numbers the explanation template quotes. Rounded to what the sentence
   * shows, so a stored flag and its rendered sentence cannot disagree.
   */
  params: Record<string, number | string>;
}

/* --------------------------------------------------------- approximations - */

/**
 * Everything §3.5 says a grade must admit to. Shown as a banner over the hand.
 *
 * - `heuristic`         the source is the §3.6 fallback, not a reference.
 * - `placeholder-range` an equity was taken against `ranges.ts`'s default
 *                       ranges, which are a stand-in until A2's charts.
 * - `antes`             antes are in the pot; the reference has none.
 * - `straddle`          a straddle moved the blinds.
 * - `stack-depth`       the effective stack is outside 100bb ±20%.
 * - `table-size`        not a six-handed table (§8: v1 covers 6-max).
 */
export const APPROXIMATIONS = [
  "heuristic",
  "placeholder-range",
  "antes",
  "straddle",
  "stack-depth",
  "table-size",
] as const;
export type Approximation = (typeof APPROXIMATIONS)[number];

/* ------------------------------------------------------- not analysed - */

/**
 * Why a whole hand is not analysed (§3.5, §8). "Saying nothing is better than
 * saying something wrong": each of these is shown to the reader by name.
 */
export const HAND_SKIP_REASONS = [
  "no-hero",
  "variant",
  "hi-lo",
  "limit",
  "tournament",
  "bomb-pot",
  "hero-cards-unknown",
  "no-decisions",
  /** Every hero decision was in a multiway pot after the flop. */
  "multiway",
] as const;
export type HandSkipReason = (typeof HAND_SKIP_REASONS)[number];

/** Why one decision of an otherwise analysed hand is not (§3.5). */
export const DECISION_SKIP_REASONS = ["multiway"] as const;
export type DecisionSkipReason = (typeof DECISION_SKIP_REASONS)[number];

export type HandStatus = "full" | "partial" | "not-analysed";

/* ---------------------------------------------------------------- facts - */

export type SuitTexture = "rainbow" | "two-tone" | "monotone";
export type Connectedness = "disconnected" | "semi-connected" | "connected";
export type Dynamism = "static" | "medium" | "dynamic";
export type HighCardClass = "ace" | "broadway" | "middle" | "low";

/** §4: the board, as a player describes it. Null before the flop. */
export interface BoardTexture {
  cards: number;
  /** A rank appears at least twice. */
  paired: boolean;
  /** A rank appears three times. */
  trips: boolean;
  /**
   * Suits by the most of one suit on the board: one per suit is rainbow, two
   * of one is two-tone, three or more is monotone (a flush is possible).
   */
  suits: SuitTexture;
  /** Three or more of one suit: some two-card hand makes a flush. */
  flushPossible: boolean;
  /** Some two-card hand makes a straight. */
  straightPossible: boolean;
  /**
   * Two-rank holdings that make a straight on this board: 0 disconnected,
   * 1–2 semi-connected, 3 or more connected.
   */
  connectedness: Connectedness;
  straightCombos: number;
  /** Highest rank on the board, 0 = deuce … 12 = ace. */
  highRank: number;
  highCard: HighCardClass;
  /**
   * How much the next card can change things: the share of unseen cards that
   * complete a flush or a four-flush or add two or more straight-making
   * holdings (an overcard that does neither counts half). Null on the river,
   * which has no next card. Static under 25%, dynamic from 45%.
   */
  volatility: number | null;
  dynamism: Dynamism | null;
}

export type MadeHandClass =
  | "straight-flush"
  | "quads"
  | "full-house"
  | "flush"
  | "straight"
  | "set"
  | "trips"
  | "two-pair"
  | "overpair"
  | "top-pair"
  | "pocket-pair-below-top"
  | "second-pair"
  | "weak-pair"
  | "underpair"
  | "ace-high"
  | "high-card"
  /** On the river the board itself is the hero's best hand. */
  | "board";

/** Kicker of a one-card pair: the best one left, one of the next two, or weaker. */
export type KickerClass = "top" | "good" | "weak";

export type DrawClass =
  | "flush-draw"
  | "nut-flush-draw"
  | "oesd"
  | "gutshot"
  | "backdoor-flush"
  | "backdoor-straight"
  | "overcards";

export type BlockerClass = "nut-flush" | "second-nut-flush" | "nut-straight" | "top-pair" | "set";

export interface MadeHand {
  class: MadeHandClass;
  kicker: KickerClass | null;
  /** The hand cannot lose to any holding the opponent could have (river only). */
  nuts: boolean;
}

/** What the decision was facing, and the hero's role in it. */
export type PreflopScenario =
  | "unopened"
  | "vs-limp"
  | "bb-option"
  | "vs-open"
  | "squeeze"
  | "vs-3bet"
  | "vs-3bet-cold"
  | "vs-4bet";

export type PostflopRole = "pfr" | "caller" | "limped";
export type PostflopFacing = "first" | "vs-bet" | "vs-raise";

/** §4. Everything below is derived from the hand alone, deterministically. */
export interface SpotFacts {
  street: DecisionStreet;
  position: Position | null;
  /** Postflop heads-up only: acts last on the street. */
  inPosition: boolean | null;
  /** Players who had not folded when the decision was made, hero included. */
  players: number;
  /** `unopened`, `vs-open`, … preflop; `pfr-ip-vs-bet`-style postflop. */
  scenario: string;
  preflopScenario: PreflopScenario | null;
  role: PostflopRole | null;
  facing: PostflopFacing | null;

  /** All in big blinds, to two decimals. */
  potBb: number;
  toCallBb: number;
  heroStackBb: number;
  effStackBb: number;
  /**
   * Stack-to-pot ratio as the street began — effective stack over the pot
   * when its first card came — the way players quote it. Postflop only.
   */
  spr: number | null;
  /** Equity the call needs: toCall / (pot + toCall). Null with nothing to call. */
  potOdds: number | null;
  /** Minimum defence frequency against the bet faced: 1 − toCall / pot. Postflop only. */
  mdf: number | null;
  /** The bet faced, as a fraction of the pot before it. */
  facingPot: number | null;
  /** The hero's own bet or raise, as a fraction of the pot it went into. */
  betPot: number | null;
  /** Stack left behind after the hero's bet or raise; null for anything else. */
  behindBb: number | null;
  allIn: boolean;

  holeCards: string[];
  /** `AKs` / `77`. */
  handClass: string | null;
  board: string[];
  texture: BoardTexture | null;
  made: MadeHand | null;
  draws: DrawClass[];
  blockers: BlockerClass[];

  /**
   * The hero's equity against the opponent's placeholder range (`ranges.ts`),
   * when a check needed it. Labelled on screen as an estimate against a
   * default range, because that is all it is until A2.
   */
  equity: {
    value: number;
    /** Which default range: e.g. `open:BTN`. */
    range: string;
    combos: number;
    method: "exhaustive" | "monte-carlo";
    /**
     * River only: the equity against the strongest quarter of that range —
     * the least a river bettor can be assumed to hold, since nothing narrows
     * the range by its betting until A4. Always ≤ `value`. Folds are judged on
     * this one, so an unnarrowed range cannot flatter a fold into a mistake.
     */
    strong: number | null;
  } | null;
}

/* ------------------------------------------------------------- records - */

export interface DecisionAnalysis {
  /** `Decision.order` — the same index the stats engine uses. */
  order: number;
  /** `PhfAction.index`: what the replayer seeks to. Stable across serialization. */
  actionIndex: number;
  street: DecisionStreet;
  action: DecisionAction;
  status: "analysed" | "not-analysed";
  reason: DecisionSkipReason | null;
  /**
   * Canonical description of the spot (§3.4) without the board, which the
   * solver phase canonicalises. Stable enough to group by; not yet a cache key.
   */
  node: string;
  options: OptionAnalysis[];
  chosen: number | null;
  evLoss: number | null;
  evLossPot: number | null;
  freqDiff: number | null;
  grade: Grade | null;
  score: number | null;
  source: AnalysisSource;
  approximations: Approximation[];
  facts: SpotFacts;
  flags: Flag[];
  /** The loudest flag, or null. What a list colours the action letter by. */
  worstFlag: FlagSeverity | null;
}

export interface HandAnalysis {
  version: AnalysisVersion;
  status: HandStatus;
  reason: HandSkipReason | null;
  heroSeat: number | null;
  /** `walk` / `limped` / `single-raised` / `3bet` / `4bet+` / `bomb`, as the stats engine reads it. */
  potType: string;
  /** Worst graded decision; null while no decision has a reference (A1). */
  grade: Grade | null;
  score: number | null;
  evLoss: number | null;
  evLossPot: number | null;
  decisions: DecisionAnalysis[];
  /** Union of every decision's approximations, plus the hand-level ones. */
  approximations: Approximation[];
  flagCount: number;
  worstFlag: FlagSeverity | null;
}
