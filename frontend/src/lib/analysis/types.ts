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
 *   analysis/2  A2b: preflop decisions graded from the charts (`charts/1`);
 *               a preflop line the charts refuse is "not analysed" with the
 *               lookup's reason; opponents' ranges derived from the charts
 *               where a node exists; the placeholder ranges parse (span fix).
 *   analysis/3  A4: heads-up river decisions graded by our solver
 *               (`source: "solver"`) from ranges narrowed through the hand
 *               (`narrowing.ts`, a heuristic model before A5); postflop
 *               equity facts against the narrowed range; a river decision the
 *               solver cannot take is "not analysed" with a `river-*` reason.
 *   analysis/4  A5a: heads-up turn decisions graded by our solver (a turn +
 *               river solve with suit isomorphism and a coarse river menu,
 *               `turn.ts`); a turn the solver cannot take is "not analysed"
 *               with a `turn-*` reason; the river's ranges are narrowed by
 *               the solved turn strategy where the turn was solved
 *               (`RiverFacts.narrowing`), by the heuristic elsewhere.
 *   analysis/5  A2c: preflop graded from the chart library (`charts/3`):
 *               9-max at 100-200bb and 6-max at 40-200bb besides 6-max
 *               100bb, the set picked per decision and named in
 *               `facts.chart.set`; 3-5 and 7-8 handed tables read with the
 *               earliest seats folded (`short-handed`); opponents' chart
 *               ranges - where every turn and river solve starts - come from
 *               the same sets, so postflop grades on those tables start from
 *               chart ranges instead of placeholders.
 *   analysis/6  A2d: `charts/4` - limp trees in every set (open limps,
 *               over-limps, isolation raises, the limper's answers; at most
 *               three limpers), so decisions behind a limp are graded instead
 *               of refused (`chart-limp`); a fourth limper is `chart-multiway`.
 *               An opponent who open-limped keeps the placeholder limp range
 *               (the charts' limper is the tremble: any hand).
 *   analysis/7  A9 (after A2d's analysis/6): multiway postflop. Every multiway decision gets facts
 *               against each opponent's narrowed range and the field
 *               (`facts.multiway`) and the multiway flags; a river call or
 *               fold facing a bet in a pot that was multiway is graded by an
 *               approximate EV against the narrowed ranges
 *               (`source: "approx"`, `multiway-approx`, capped at Mistake);
 *               a turn or river that began heads-up after a multiway flop is
 *               solved as before from ranges narrowed through the multiway
 *               streets (`multiway-history`). Narrowing reads three or more
 *               ranges (`narrowing.ts`, the MDF split).
 *   analysis/8  A5b on: the flop library (6-max 100bb, 12 lines × 100
 *               flops) grades heads-up flop decisions on its lines from the
 *               solve - exact flops combo for combo, other flops from their
 *               representative by hand category (`flop-mapped`) - and narrows
 *               the flop's ranges by the solved strategies, so the turn and
 *               river start from them (`flopLibrary.ts`).
 *   analysis/9  The button-small-blind pot reads its flop chunks: a hand's
 *               placed line (`fffrc`) matches the library's (`fffrcf`) once
 *               trailing folds are dropped (`sameLine`); and when the two
 *               flop players' lookups land on sets of different depths, both
 *               are placed on the set nearest the pair's effective stack
 *               (`chartLineOf`), so their flop can read the library.
 *   analysis/10 A2e: `charts/5`, the straddle set (6-max 100bb, a 2bb UTG
 *               straddle). A straddled hand that fits it - one straddle, 2bb,
 *               from the first seat left of the big blind, 4-6 handed, the
 *               effective stack within 100bb ±20% - is graded preflop from it
 *               instead of `chart-straddle`, its players' preflop ranges (and
 *               the postflop walks and solves that start from them) are its,
 *               and it no longer carries the hand-level `straddle`
 *               approximation. Every other straddle is refused as before.
 *   analysis/11 `charts/6`: the 6-max and 9-max 200bb sets re-solved for
 *               9,000 iterations (docs/CHARTS.md §5.1). Their big blind
 *               facing a single limp is graded instead of `chart-rare-line`,
 *               and every grade, EV and preflop range read from them moves
 *               by the longer solve.
 *   analysis/12 A mapped flop (and a hero combo outside an exact chunk's
 *               range) reads its representative by finer hand categories
 *               (`flopReadingBucket`, `readingChain`: the nut straight, the
 *               set by board card, two pair by which two, overcards, the
 *               flush and straight draws apart, nut backdoors), falling back
 *               to the coarse `flopBucket` when a fine one is thin; the
 *               stored `facts.flop.bucket` is the fine category (§10
 *               2026-10-09).
 *   analysis/13 A hero preflop decision on a line too rare for its set
 *               (`chart-rare-line`) is graded on the neighbouring depth of the
 *               same table that charts the line - 100bb read at 150 or 60bb,
 *               never further - with `rare-line-depth`, capped at Inaccurate
 *               (docs/CHARTS.md §7.1, ANALYSIS-PLAN §10 2026-10-09).
 *   analysis/14 `charts/7`: the 9-max 150bb set re-solved for 9,000
 *               iterations (docs/CHARTS.md §5.1), so its big blind facing a
 *               single limp converges from every seat. Every grade, EV and
 *               preflop range read from it moves by the longer solve -
 *               including the 9-max 100bb and 200bb rare lines read on it
 *               (`rare-line-depth`).
 *   analysis/15 A flop call or fold facing a bet in a pot three or more saw
 *               the flop of is graded approximately (`source: "approx"`,
 *               `multiway-approx`, `flop-realisation`): the river's EV over
 *               who answers, the hero's share times a realisation factor
 *               measured on the flop library, only the EV loss beyond 5% of
 *               the pot counted, capped at Mistake (ANALYSIS-PLAN §10
 *               2026-10-10).
 *   analysis/16 A turn call or fold facing a bet in a pot three or more saw
 *               the turn of is graded the same way (`turn-realisation`): the
 *               factor measured on Rail's own heads-up turn solves, capped at
 *               Mistake (ANALYSIS-PLAN §10 2026-10-10, multiway turns).
 *   analysis/17 The flop's approximate call follows the turn's two rules: a
 *               call that ends the betting (an all-in) takes no factor, and a
 *               call or fold facing a re-raise is refused (`multiway-reraise`)
 *               unless the call ends the betting; the flop table is refitted
 *               without the all-in calls (`floplib-r/2`). Placeholder ranges
 *               unchanged (ANALYSIS-PLAN §10 2026-10-10, multiway rules and
 *               placeholder ranges).
 *   analysis/18 Opponents' (and the hero's) preflop ranges for the postflop
 *               walks and equity facts: a line at a depth no set covers, or
 *               too rare for its set, is read on the nearest charted depth
 *               below or above (`range-neighbour-depth`), except a flat call
 *               of a single raise; a limper who called an isolation raise
 *               starts from the placeholder limp range (`range-limp-call`).
 *               The flop library's placement is unchanged (ANALYSIS-PLAN §10
 *               2026-10-10, neighbouring ranges).
 *   analysis/19 Opponents' flat calls of a single raise (cold calls, the big
 *               blind's defence) and limps from outside the blinds (first in,
 *               behind a limper, or then calling the raise) start the walks
 *               and equity facts from the population range fitted on shown
 *               hands (`population/1`, `range-population`), ahead of the
 *               charts and the placeholder; the hero's own range and the
 *               trainers are unchanged (ANALYSIS-PLAN §10 2026-10-10,
 *               population callers).
 *   analysis/20 An opponent's big blind defence with at least 30 hands of
 *               their own statistics in the learner's library (the
 *               opponents panel's VPIP and PFR, handed in as
 *               `AnalyzeOptions.villains`) starts from the population range
 *               moved by their VPIP − PFR, shrunk toward the pool's by the
 *               sample (`villain/1`, `range-villain`); the decision records
 *               the sample (`SpotFacts.villain`). No other line moves; no
 *               statistics, no change. Population lines are labelled as
 *               such on screen (they read "any two cards" before)
 *               (ANALYSIS-PLAN §10 2026-10-10, villain statistics).
 */
export const ANALYSIS_VERSION = "analysis/20" as const;
export type AnalysisVersion = typeof ANALYSIS_VERSION;

/** The four streets a decision can be made on. */
export type DecisionStreet = Exclude<Street, "showdown">;
export type DecisionAction = "fold" | "check" | "call" | "bet" | "raise";

/* ---------------------------------------------------------------- grades - */

/** §2. Ordered best to worst; `GRADES.indexOf` is the severity. */
export const GRADES = ["perfect", "good", "inaccurate", "mistake", "blunder"] as const;
export type Grade = (typeof GRADES)[number];

/** Where a decision's reference came from. Always shown next to the grade. */
/**
 * `approx` (A9): an EV comparison against narrowed ranges, not a solved
 * strategy — a multiway river call or fold. Graded on §2's thresholds,
 * capped at Mistake, always labelled "approximate (multiway)".
 */
export type AnalysisSource = "chart" | "solver" | "heuristic" | "approx";

/** One option at a node, as the reference strategy plays it (§1). */
export interface OptionAnalysis {
  action: DecisionAction;
  /** Big blinds, as solved (bucketed, §3.3). */
  size?: number;
  /**
   * Preflop: what the actor has in after the action, in bb — "raise to 7.5",
   * "call 2.5", a fold's or check's own blind. Charts are not pot-relative.
   */
  sizeBb?: number;
  /** The option is the all-in (a chart's 5-bet shove). */
  allIn?: boolean;
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
 *
 * Multiway (A9), each resting on the narrowed ranges, so a note unless said:
 *
 * - `multiway-bluff`     bet or raised with little equity against the field
 *                        into two or more players, when even folding as often
 *                        as heads-up each, they would all fold less often
 *                        than the bet needs. Inaccurate only on the river
 *                        with almost no equity and less than half the folds.
 * - `multiway-slowplay`  checked or flat-called a strong but vulnerable hand
 *                        (one pair at the top, two pair, a set, a made hand
 *                        on a board that changes) on the flop or turn with
 *                        two or more opponents: more hands to outdraw it.
 * - `multiway-dominated-draw` called off a large part of the stack with a
 *                        draw that is not to the nuts, little made hand and
 *                        less equity against the field than the price.
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
  "multiway-bluff",
  "multiway-slowplay",
  "multiway-dominated-draw",
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
 *                       ranges: no chart node exists for the opponent's line.
 * - `preflop-range`     an equity was taken against the opponent's range as
 *                       the charts play their preflop line — not narrowed by
 *                       anything that happened after the flop (that is A4).
 * - `antes`             antes are in the pot; the reference has none.
 * - `straddle`          a straddle moved the blinds, and no chart set models it
 *                       (A2e: the straddle set covers one straddle shape).
 * - `stack-depth`       the effective stack is outside 100bb ±20%.
 * - `table-size`        not a six-handed table (§8: v1 covers 6-max).
 *
 * Chart grades (A2b, §3.1, §3.5):
 *
 * - `model`             the chart set has a known modelling weakness
 *                       (`charts/1` under-rates implied-odds hands, §3.1).
 * - `short-handed`      five players dealt in, read as 6-max with UTG folded.
 * - `stack-depth-near`  within 100bb ±20%, but more than 5% away from it.
 * - `off-tree-size`     a raise in the line (the hero's or an opponent's) is
 *                       more than 25% of the pot from the chart's size; the
 *                       grade is capped at Inaccurate (§3.3).
 * - `out-of-range`      the hero's hand never reaches this node in the
 *                       reference; its options are the best response, not a
 *                       mix the reference ever plays.
 *
 * River grades (A4, §3.2, §3.3, §3.5):
 *
 * - `narrowing-heuristic` both ranges were narrowed on the flop and turn by
 *                       `narrowing.ts`'s heuristic model, not by a solved
 *                       strategy (A5 replaces it). Every solver grade and
 *                       every postflop equity against a narrowed range.
 * - `rake-profile`      solved with the charts' rake profile (5%, capped at
 *                       3 bb), not the room's own.
 * - `size-translated`   a bet or raise in the river line was mapped onto the
 *                       solver's sizes (33 / 75 / 150% and all-in; raises
 *                       75% and all-in) by pseudo-harmonic translation,
 *                       within 25% of the pot. Not capped.
 * - `solver-unconverged` the solve stopped at its iteration cap above 0.5% of
 *                       the pot exploitable.
 * - `range-cap`         the solver's numbers made the move a Blunder, but
 *                       ranges a heuristic narrowed cannot carry that: the
 *                       grade is capped at Mistake. Not applied to a move
 *                       that loses whatever the opponent holds (folding a
 *                       hand that cannot lose; calling with one that beats
 *                       nothing in the opponent's preflop range).
 * - `range-sensitive`   re-solved with the narrowing at half strength, the
 *                       grade moved by more than one class; the milder of
 *                       the two is the one shown (§3.5, §9).
 *
 * Turn grades (A5a) carry the river's codes where they mean the same thing
 * (`narrowing-heuristic` for the flop's narrowing, `rake-profile`,
 * `size-translated` for the turn's sizes 75% and all-in, raises 75% and
 * all-in, `solver-unconverged` above 1% of the pot, `range-cap`,
 * `range-sensitive`), plus:
 *
 * - `coarse-river`      the turn was solved with a coarse river below it -
 *                       one bet size (75%) and all-in, no raise - and with
 *                       the turn's all-in only up to three pots. The river
 *                       decisions themselves are graded by their own solve
 *                       with the full menu.
 *
 * Flop grades from the flop library (A5b, behind `FLOP_LIBRARY_ENABLED`)
 * carry `rake-profile`, `coarse-river` (the library's turn and river are
 * coarse too), `size-translated` / `off-tree-size`, `solver-unconverged`,
 * `out-of-range` and `range-cap` as above, plus:
 *
 * - `flop-mapped`       the library has not solved this flop; it was read
 *                       from the representative flop of the same texture
 *                       nearest to it (`lib/solver/flopSet.ts`).
 * - `library-bucketed`  the hero's hand was read by hand category (made
 *                       hand and draw) - the mean of the combos in that
 *                       category - not combo for combo: always on a mapped
 *                       flop, and for a hand outside the chart's range.
 *
 * Turn and river grades of a hand whose flop ranges came from the library
 * carry the mapping codes instead of `narrowing-heuristic` for the flop.
 *
 * Preflop chart grades (A2d) add:
 *
 * - `limp-tremble`      a preflop grade in a pot a seat other than the blinds
 *                       limped (`charts/4`): the reference itself barely
 *                       limps there, so it plays against a limper who may
 *                       hold any hand (docs/CHARTS.md §1.3).
 * - `rare-line-depth`   (analysis/13) the line is too rare at the answering
 *                       set's depth to be charted there (`rare-line`), and is
 *                       read on the neighbouring depth of the same table that
 *                       charts it (docs/CHARTS.md §7.1). Capped at Inaccurate.
 *
 * Multiway (A9):
 *
 * - `multiway-approx`   an approximate grade (`source: "approx"`): a river
 *                       call against a fold, by showdown EV against each
 *                       opponent's narrowed range; players still to act call
 *                       or fold by the narrowing model (never raise); raising
 *                       is not one of the options compared. Capped at
 *                       Mistake.
 * - `flop-realisation`  (analysis/15) an approximate flop call or fold: the
 *                       share of the pot a hand goes on to win is its equity
 *                       against the field times a factor measured on the
 *                       heads-up flop library by position and hand category;
 *                       only the EV loss beyond 5% of the pot counts.
 * - `turn-realisation`  (analysis/16) the same on the turn: one card to come,
 *                       the factor measured on Rail's own heads-up turn
 *                       solves; only the EV loss beyond the turn's margin
 *                       counts.
 * Preflop ranges (analysis/18), wherever `placeholder-range` would be asked:
 *
 * - `range-neighbour-depth` a range the walks or an equity start from was read
 *                       from the charts at the nearest charted depth (the
 *                       line is too rare for its set, or no set covers the
 *                       depth); never a flat call of a single raise.
 * - `range-population`  (analysis/19) an opponent's flat call of a single
 *                       raise or limp from outside the blinds starts from the
 *                       population range fitted on shown hands
 *                       (`population.ts`), not the charts' or the
 *                       placeholder.
 * - `range-villain`     (analysis/20) that population range, for a big
 *                       blind's defence, moved by the player's own VPIP − PFR
 *                       in the learner's library, shrunk by the sample
 *                       (`villain.ts`); the sample is in `SpotFacts.villain`.
 * - `range-limp-call`   a limper who called an isolation raise starts from
 *                       the placeholder limp range, not the `call` one.
 *
 * - `multiway-history` solved heads-up from a street that began heads-up,
 *                       but three or more saw the flop: the ranges were
 *                       narrowed through the multiway streets, with card
 *                       removal between opponents only approximate.
 */
export const APPROXIMATIONS = [
  "heuristic",
  "placeholder-range",
  "preflop-range",
  "antes",
  "straddle",
  "stack-depth",
  "table-size",
  "model",
  "short-handed",
  "stack-depth-near",
  "off-tree-size",
  "out-of-range",
  "narrowing-heuristic",
  "rake-profile",
  "size-translated",
  "solver-unconverged",
  "range-cap",
  "range-sensitive",
  "coarse-river",
  "flop-mapped",
  "library-bucketed",
  "limp-tremble",
  "rare-line-depth",
  "multiway-approx",
  "multiway-history",
  "flop-realisation",
  "turn-realisation",
  "range-neighbour-depth",
  "range-limp-call",
  "range-population",
  "range-villain",
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
  /** Every hero decision was in a multiway pot after the flop, and none got an approximate grade. */
  "multiway",
] as const;
export type HandSkipReason = (typeof HAND_SKIP_REASONS)[number];

/**
 * Why a preflop decision has no chart grade: the chart lookup's refusal
 * (`ChartMissReason` in `lib/charts/lookup.ts`, `docs/CHARTS.md` §7), or
 * `preflopSpotFromHand`'s, prefixed `chart-` so a preflop "multiway" (a fifth
 * entrant) never reads as the postflop one. `chart-unavailable`: the charts
 * were not loaded (a caller bug, never stored by the rebuild).
 */
export const CHART_SKIP_REASONS = [
  "chart-straddle",
  "chart-ante",
  "chart-players",
  "chart-stack-depth",
  "chart-limp",
  "chart-multiway",
  "chart-cold-call",
  "chart-off-tree",
  "chart-rare-line",
  "chart-action-not-modelled",
  "chart-bad-input",
  "chart-game",
  "chart-bomb-pot",
  "chart-no-positions",
  "chart-no-hero",
  "chart-no-decision",
  "chart-unavailable",
] as const;
export type ChartSkipReason = (typeof CHART_SKIP_REASONS)[number];

/**
 * Why a heads-up river decision has no solver grade (A4):
 *
 * - `river-multiway-flop` the river began with three or more players in
 *                         (A9: a river that began heads-up after a multiway
 *                         flop is solved, `multiway-history`); a call or fold
 *                         there gets the approximate grade instead.
 * - `river-range-unknown` a player has no preflop line to start a range from.
 * - `river-range-empty`   card removal or narrowing left a range empty.
 * - `river-off-tree`      the line left the solver's tree: more raises than
 *                         its cap, or an action it has no edge for.
 * - `river-unreached`     the solved strategies (almost) never take this line
 *                         with the narrowed ranges: under 0.5% of a range
 *                         reaches the decision, so its strategy is noise.
 * - `river-solve-failed`  the solver refused the spot (a bug, never a guess).
 */
export const RIVER_SKIP_REASONS = [
  "river-multiway-flop",
  "river-range-unknown",
  "river-range-empty",
  "river-off-tree",
  "river-unreached",
  "river-solve-failed",
] as const;
export type RiverSkipReason = (typeof RIVER_SKIP_REASONS)[number];

/**
 * Why one decision of an otherwise analysed hand is not (§3.5): a multiway
 * pot after the flop, a preflop line the charts do not cover, or a river the
 * solver cannot take.
 */
/**
 * Why a heads-up turn decision has no solver grade (A5a): the river's
 * reasons, on the turn (`turn-unreached`: under 2% of a range reaches it).
 */
export const TURN_SKIP_REASONS = [
  "turn-multiway-flop",
  "turn-range-unknown",
  "turn-range-empty",
  "turn-off-tree",
  "turn-unreached",
  "turn-solve-failed",
] as const;
export type TurnSkipReason = (typeof TURN_SKIP_REASONS)[number];

/**
 * Why a multiway postflop decision has no grade (A9). Each still gets its
 * facts and flags:
 *
 * - `multiway`               no reference exists for the spot: anything but
 *                            a call or fold facing a bet (§10: A9 on the
 *                            river, analysis/15 the flop, analysis/16 the
 *                            turn);
 * - `multiway-side-pot`      a river call with a side pot (an all-in for
 *                            less) — the showdown is not one pot;
 * - `multiway-crowded`       more than three players still to answer the bet;
 * - `multiway-range-unknown` a player's range could not be walked (no
 *                            preflop line, or emptied by the board);
 * - `multiway-reraise`       a turn (analysis/16) or flop (analysis/17) call
 *                            or fold facing a re-raise: the realisation
 *                            factors were measured on trees with one raise.
 */
export const MULTIWAY_SKIP_REASONS = ["multiway", "multiway-side-pot", "multiway-crowded", "multiway-range-unknown", "multiway-reraise"] as const;
export type MultiwaySkipReason = (typeof MULTIWAY_SKIP_REASONS)[number];

export const DECISION_SKIP_REASONS = [
  ...MULTIWAY_SKIP_REASONS,
  ...CHART_SKIP_REASONS,
  ...RIVER_SKIP_REASONS,
  ...TURN_SKIP_REASONS,
] as const;
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
   * The hero's equity against the opponent's preflop range, when a check
   * needed it: the range the charts play for the opponent's line where a
   * chart node exists (`source: "chart"`), else `ranges.ts`'s placeholder.
   * Never narrowed by postflop betting (A4), and labelled so on screen.
   */
  equity: {
    value: number;
    /** The opponent's line and position: e.g. `open:BTN`. */
    range: string;
    /**
     * Where the range came from. Absent on `analysis/1` rows: the placeholder.
     * `narrowed`: the preflop range (charts or placeholder) narrowed by the
     * postflop betting so far (A4, heuristic). `solver`: the opponent's range
     * at the river node, as the solve plays the line.
     */
    source?: "chart" | "placeholder" | "narrowed" | "solver";
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

  /**
   * Preflop, when the charts graded the decision: the node it was graded
   * at, so the study view can draw the whole 13×13 chart for it.
   */
  chart?: ChartRef | null;

  /** River, when the solver graded the decision: the solve and the ranges at the node (A4). */
  river?: RiverFacts | null;

  /** Turn, when the solver graded the decision (A5a). */
  turn?: TurnFacts | null;

  /** Flop, when the flop library graded the decision (A5b, behind `FLOP_LIBRARY_ENABLED`). */
  flop?: FlopFacts | null;

  /** A multiway postflop decision (A9): the field, the MDF split, fold equity, outs, the approximate EV. */
  multiway?: MultiwayFacts | null;

  /**
   * (analysis/20) The opponent whose preflop range was moved by their own
   * statistics in the learner's library (`range-villain`), with the sample:
   * the one input of this decision that is not from the hand alone. Absent
   * when no range read any.
   */
  villain?: VillainFact | null;
}

/** An opponent's own statistics a range was moved on (analysis/20, `villain.ts`). */
export interface VillainFact {
  position: Position | null;
  /** `bb-defence:BB`: the population line the statistics moved. */
  range: string;
  /** Hands behind the statistics (`vpip_opp`). */
  hands: number;
  /** (VPIP − PFR) / hands, unshrunk. */
  passive: number;
  /** The rate shrunk toward the pool's, as the range read it. */
  shrunk: number;
  /** What a rebuild hands back to reproduce the range (`VillainStats`). */
  stats: { vpipOpp: number; vpip: number; pfr: number };
}

/** What the flop library says about a graded flop decision (A5b). Plain numbers; the chunk is not stored. */
export interface FlopFacts {
  source: "library";
  /** Library line id, e.g. `btn-bb`. */
  line: string;
  /** The flop the chunk was solved on (canonical key): the hand's own, or its representative. */
  flop: string;
  /** Read from a representative flop (`flop-mapped`). */
  mapped: boolean;
  /** Texture distance to it (`flopSet.ts`), 0 when exact. */
  distance: number;
  /** Library tree, e.g. `flop-m1`. */
  tree: string;
  /** The node in the solved tree, e.g. `X-B1.82`. */
  path: string;
  iterations: number;
  /** Exploitability the chunk's solve reached, % of the flop pot. */
  exploitabilityPct: number;
  /** The hero's hand category when it was read by category (`library-bucketed`): `flopReadingBucket` since `analysis/12` (e.g. `tp-good/fd.`), `flopBucket` before (`tp-good/fd`). */
  bucket: string | null;
  translated: number | null;
  reach: { hero: number; villain: number };
  capped?: Grade | null;
}

/** One opponent of a multiway decision, in acting order (A9). */
export interface MultiwayOpponent {
  position: Position | null;
  /** `line:position`, as `SpotFacts.equity.range`. */
  range: string;
  source: "chart" | "placeholder";
  /**
   * How the preflop range was read beyond its source (analysis/18): on a
   * neighbouring depth's chart, or a limp-caller's limp placeholder. Absent
   * when neither.
   */
  approx?: ("range-neighbour-depth" | "range-limp-call" | "range-population" | "range-villain")[];
  /** The hero's equity against this range alone, narrowed to the decision. */
  equity: number | null;
  /** Weighted combos in the range, the hero's cards and the board removed. */
  combos: number;
  /** Still to act after the hero on this street. */
  toAct: boolean;
  allIn: boolean;
}

/**
 * Multiway facts (A9). Every number is against ranges narrowed through the
 * hand by the heuristic model with three or more ranges (`narrowing.ts`).
 */
export interface MultiwayFacts {
  /** Players in the pot at the decision, the hero included. */
  players: number;
  /** The narrowing model, e.g. `heuristic/2+mw`. */
  model: string;
  opponents: MultiwayOpponent[];
  /** The hero's equity against every opponent at once (the field). */
  field: number | null;
  fieldMethod: "exhaustive" | "monte-carlo" | null;
  /** Opponents still to act after the hero on this street. */
  behind: number;
  /** The hero acts last on this street among the players still in. */
  lastToAct: boolean;
  /** Not facing a bet, with the preflop raiser still to act after the hero: checking to the raiser. */
  raiserBehind: boolean;
  /**
   * Facing a bet: the defence it asks of the table (`mdf`, as heads-up) and
   * what that is per defender if they share it independently (`each`,
   * `1 − α^(1/k)` over `defenders`).
   */
  mdfSplit: { mdf: number; defenders: number; each: number } | null;
  /**
   * The hero bet or raised: the fold rate the bet needs (`needed`, α), the
   * model's estimate of each opponent's fold rate if they defended as they
   * would heads-up, and the chance everyone folds (their product).
   */
  foldEquity: { needed: number; each: number[]; all: number } | null;
  /**
   * Flop and turn: of the `cards` next cards, how many make the hero's hand
   * the nuts, and how many make it a straight or better that is not the nuts.
   */
  outs: { nut: number; nonNut: number; cards: number } | null;
  /** A straight-or-better draw whose outs are mostly not the nuts, with two or more opponents. */
  reverseImplied: boolean;
  /** River, flop (`analysis/15`) or turn (`analysis/16`), facing a bet: the approximate EV of calling against folding. */
  ev: MultiwayEv | null;
}

/**
 * The approximate call (A9 on the river; the flop since `analysis/15`, the
 * turn since `analysis/16`): showdown EV against the narrowed ranges, on the
 * flop and turn times a realisation factor measured on Rail's own solves.
 */
export interface MultiwayEv {
  /** bb, net from the decision: calling against folding (a fold is 0). */
  call: number;
  /** The hero's share of the pot at showdown, averaged over the ways the players to act answer. */
  equity: number;
  /** Expected pot if the hero calls, bb, before rake. */
  pot: number;
  /** Players still to answer after the hero's call, and the model's chance each calls. */
  respond: Array<{ position: Position | null; call: number }>;
  /** Ways the players to act can answer (call or fold each). */
  scenarios: number;
  rake: string;
  /** The grade before the Mistake cap, or null. */
  capped: Grade | null;
  /** The grade on the half-strength narrowing; null when not run. */
  sensitivity: { model: string; grade: Grade } | null;
  /**
   * Flop (`analysis/15`) and turn (`analysis/16`): the realisation table
   * (`floplib-r/1`, since `analysis/17` `floplib-r/2`; `turnsolve-r/1`), the hero's category (`made|d` /
   * `made|nd`), the factor applied (averaged over
   * the ways the players to act answer), how often the hero is last to act
   * after the call, and the margin of the pot the grade forgives.
   */
  realisation?: {
    model: string;
    category: string;
    factor: number;
    ip: number;
    margin: number;
    /** When above 0: how often the call ends the betting (an all-in), where the share takes no factor (the turn since `analysis/16`, the flop since `analysis/17`). */
    allIn?: number;
  };
}

/**
 * The hero's hand against the opponent's range at a turn node, for the *why*:
 *
 * - `value`          ahead of most of the range now, and most rivers keep it so;
 * - `vulnerable`     ahead now, but a fifth or more of the rivers turn it into
 *                    a loser: a hand that wants protection;
 * - `draw`           behind now, with rivers that make it strong;
 * - `bluff-catcher`  facing a bet, ahead of the bluffs and behind the value;
 * - `medium`         a middling hand that wants a cheap showdown;
 * - `air`            little equity and few rivers that help.
 */
export type TurnRole = "value" | "vulnerable" | "draw" | "bluff-catcher" | "medium" | "air";

/**
 * What a turn solve says about the spot, stored with the grade (A5a). Plain
 * numbers, never the strategy: the study view re-solves to draw it.
 */
export interface TurnFacts {
  /** Narrowing model of the flop, e.g. `heuristic/2` (`-half` when the sensitivity check chose it). */
  model: string;
  /** Bet-menu profile, e.g. `turn-m1`. */
  tree: string;
  rake: string;
  /** The node in the solved tree, e.g. `X-B7.5`. */
  path: string;
  iterations: number;
  /** Exploitability reached in the full turn + river tree, % of the pot at the start of the turn. */
  exploitabilityPct: number;
  converged: boolean;
  /** `spotHash` of the spot key (§3.4). */
  spot: string;
  /** River cards the solve dealt: one per suit-isomorphism class (44 when no suits are interchangeable). */
  riverClasses: number;
  heroCombos: number;
  villainCombos: number;
  /** Share of the opponent's range at the node the hero's hand beats now, ties half. */
  heroBeats: number;
  /** The hero's equity against that range over every river card. */
  equity: number;
  /** Share of river cards after which the hero's hand beats at least 75% / under 25% of that range. */
  rivers: { strong: number; weak: number };
  role: TurnRole;
  villain: { strong: number; medium: number; weak: number; shape: RangeShape };
  translated: number | null;
  reach: { hero: number; villain: number };
  capped?: Grade | null;
  sensitivity?: { model: string; grade: Grade } | null;
}

/** The hero's hand against the opponent's range at a river node, for the *why*. */
export type RiverRole = "value" | "bluff-catcher" | "weak" | "thin-value" | "showdown" | "air";
/** The shape of a range against the other one: `polar` (strong and weak, little between), `merged`, or `mixed`. */
export type RangeShape = "polar" | "merged" | "mixed";

/**
 * What a river solve says about the spot, stored with the grade. Plain
 * numbers only: the strategy itself is never stored (§3.4); the study view
 * re-solves, deterministically, to draw it.
 */
export interface RiverFacts {
  /** Narrowing model, e.g. `heuristic/2` (`heuristic/2-half` when the sensitivity check chose the softer one). */
  model: string;
  /** Bet-menu profile, e.g. `river-m1`. */
  tree: string;
  /** Rake profile name, e.g. `5%-cap3bb-nfnd`. */
  rake: string;
  /** The node in the solved tree, e.g. `X-B6.5`. */
  path: string;
  iterations: number;
  /** Exploitability reached, % of the pot at the start of the river. */
  exploitabilityPct: number;
  converged: boolean;
  /** `spotHash` of the spot key (§3.4), for a shared cache later. */
  spot: string;
  /** Weighted combos in each range at the node (the opponent's without the hero's cards). */
  heroCombos: number;
  villainCombos: number;
  /** Share of the opponent's range at the node the hero's hand beats, ties half. */
  heroBeats: number;
  role: RiverRole;
  /** The opponent's range at the node, by strength against the hero's range there. */
  villain: { strong: number; medium: number; weak: number; shape: RangeShape };
  /** Share of the opponent's strong and weak combos the hero's own cards remove. */
  blocks: { strong: number; weak: number };
  /** The furthest a size in the line was mapped, as a fraction of the pot; null if none was. */
  translated: number | null;
  /** Share of each range, by weight as the river came, that the solve takes down this line to the node. */
  reach: { hero: number; villain: number };
  /**
   * How the ranges reached the river (A5a): `turn-solver` when the turn was
   * solved and the river's ranges are the solved turn strategy's, else
   * `heuristic` (the model narrowed the turn too). Absent before A5a.
   */
  narrowing?: "heuristic" | "turn-solver";
  /** The grade before the Mistake cap (`range-cap`), or null when no cap applied. Absent before the cap existed. */
  capped?: Grade | null;
  /**
   * The sensitivity check: the grade the other narrowing gave (the half-strength
   * one, or — when that one is shown — the full one). Null when not run: it
   * runs only for grades of Inaccurate or worse.
   */
  sensitivity?: { model: string; grade: Grade } | null;
}

/** A chart node, by name: the set it is in and its line key (`docs/CHARTS.md` §6). */
export interface ChartRef {
  /** Chart set id, e.g. `nlhe-cash-6max-100bb`. */
  set: string;
  /** Line key: one letter per action before the decision (`"fffr"`). */
  line: string;
  /** The node's scenario in the charts' vocabulary (`rfi`, `vs-open`, …). */
  scenario: string;
  /** How much of the hero's class reaches the node, 0..1. */
  inRange: number;
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
  /**
   * Why the hand is not analysed: a hand-level reason, or — when every one of
   * its decisions was skipped — the first decision's reason.
   */
  reason: HandSkipReason | DecisionSkipReason | null;
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
