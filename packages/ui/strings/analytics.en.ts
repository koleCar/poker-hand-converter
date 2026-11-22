/**
 * The Analytics screen's words (docs/ANALYTICS.md), English
 * (`AnalyticsStrings`). `analytics.hr.ts` is the same shape. Step 2 adds the
 * spot names (`analytics/spot.ts`), Step 3 the checker's and the findings'
 * (`analytics/findings.ts`); later steps add the screen's.
 */

/**
 * What a finding's why-sentence reads (`analytics/findings.ts` fills it from
 * the checker's `CheckerWhy`): numbers already formatted in the reader's
 * locale ("62%", "1.24").
 */
export interface AnalyticsWhyWords {
  /** The lead stat's action: "fold", "raise", ... and its plural noun. */
  verb: string;
  noun: string;
  /** The hand class with the most extra / missing actions; null preflop or without one. */
  cls: string | null;
  /** The class's rate (a share: its part of your actions) and the reference's. */
  classPlayer: string;
  classTarget: string;
  /** bb a taken decision of the class gave up; null when the stat is too low. */
  worth: string | null;
  /** The costliest spot; null without one. */
  spot: string | null;
  spotPlayer: string;
  spotTarget: string;
  /** Where the target comes from: "the solver", and its possessive. */
  ref: string;
  refOf: string;
  /** The lead stat is a weak share: the class figures are its composition. */
  share: boolean;
}

type Why = (w: AnalyticsWhyWords) => string;
type Lean = { loose: string; tight: string };

const sentences = (...parts: (string | null | false)[]) => parts.filter(Boolean).join(" ");
const spotLine = (w: AnalyticsWhyWords) =>
  w.spot && `Biggest gap: ${w.spot} (you ${w.spotPlayer}, ${w.ref} ${w.spotTarget}).`;
/** "Middle pair: you fold 62% of these hands, the solver 18%." / "only 4%". */
const classLine = (w: AnalyticsWhyWords, only: boolean) => {
  if (!w.cls) return null;
  const o = only ? "only " : "";
  return w.share
    ? `${w.cls} makes ${o}${w.classPlayer} of your ${w.noun}, ${w.refOf} ${w.classTarget}.`
    : `${w.cls}: you ${w.verb} ${o}${w.classPlayer} of these hands, ${w.ref} ${w.classTarget}.`;
};
/** Too much of an action: what each one gave up. */
const eachLine = (w: AnalyticsWhyWords) => w.worth && `Each one gives up ${w.worth} bb.`;
const preflop: { loose: Why; tight: Why } = { loose: (w) => sentences(spotLine(w)), tight: (w) => sentences(spotLine(w)) };
const postflop: { loose: Why; tight: Why } = {
  loose: (w) => sentences(classLine(w, false), eachLine(w), spotLine(w)),
  tight: (w) => sentences(classLine(w, true), spotLine(w)),
};

export const analyticsUiEn = {
  /** The catalogue labels' language (`config/stats/analytics.json`). */
  lang: "en" as "en" | "hr",
  spot: {
    versus: (hero: string, opponent: string) => `${hero} vs ${opponent}`,
    multi: "2+",
    anySeat: "Any seat",
    separator: " · ",
    pots: {
      limped: "Limped pot",
      "single-raised": "Single-raised pot",
      "3bet": "3-bet pot",
      "4bet+": "4-bet+ pot",
      bomb: "Bomb pot",
    } as Record<string, string>,
    roles: {
      unopened: "First in",
      "vs-limp": "vs a limp",
      "bb-option": "Big blind option",
      "vs-open": "vs an open",
      squeeze: "Squeeze spot",
      "vs-3bet": "vs a 3-bet",
      "vs-3bet-cold": "vs a 3-bet, cold",
      "vs-4bet": "vs a 4-bet",
      pfr: "as the raiser",
      caller: "as the caller",
      limped: "in a limped pot",
    } as Record<string, string>,
  },
  /** A stat against its target. */
  checker: {
    streets: { preflop: "Preflop", flop: "Flop", turn: "Turn", river: "River", showdown: "Showdown" } as Record<string, string>,
    percent: (value: string) => `${value}%`,
    /** A gap in points, signed: "+11 pts". */
    points: (value: string) => `${value} pts`,
    /** The gap in words, then in points. */
    gap: (words: string, points: string) => `${words} · ${points}`,
    inRange: "In range",
    notSure: "Not sure yet",
    noTarget: "No target",
    source: { charts: "Charts", solver: "Solver" } as Record<string, string>,
  },
  /** Overview's findings: a headline per family and lean, then why. */
  findings: {
    ref: { charts: "the charts", solver: "the solver" } as Record<string, string>,
    refOf: { charts: "the charts'", solver: "the solver's" } as Record<string, string>,
    /** By action class: the verb ("you fold") and the plural noun ("your folds"). */
    verbs: {
      fold: { verb: "fold", noun: "folds" },
      call: { verb: "call", noun: "calls" },
      raise: { verb: "raise", noun: "raises" },
      bet: { verb: "bet", noun: "bets" },
      vpip: { verb: "play", noun: "hands played" },
      pfr: { verb: "raise", noun: "raises" },
    } as Record<string, { verb: string; noun: string }>,
    headline: {
      range: { loose: "You play too loose preflop", tight: "You play too tight preflop" },
      vs_open: { loose: "You fight opens too hard", tight: "You let opens through too easily" },
      vs_three_bet: { loose: "You fight 3-bets too hard", tight: "You give up to 3-bets too often" },
      gives_up: { loose: "You pay off too much after the flop", tight: "You give up too many pots after the flop" },
      flop_raise: { loose: "You raise the flop too much", tight: "You rarely raise the flop" },
      cbet: { loose: "You cbet and barrel too much", tight: "You give up too often as the preflop raiser" },
      river_aggression: { loose: "You are too aggressive on the river", tight: "You rarely bet or raise the river" },
    } as Record<string, Lean>,
    /** A weak share leading its finding says what it is about. */
    headlineByStat: {
      flop_raise_weak: { loose: "Too many of your flop raises are bluffs", tight: "Your flop raises are almost all value" },
      river_bet_weak: { loose: "Too many of your river bets are bluffs", tight: "You rarely bluff the river" },
      river_raise_weak: {
        loose: "Too many of your river raises are bluffs",
        tight: "Your river raises are almost all value",
      },
    } as Record<string, Lean>,
    /** Without a family's own: the lead stat and its words ("Flop fold vs bet: folds too much"). */
    fallbackHeadline: (stat: string, words: string) => `${stat}: ${words}`,
    why: {
      range: preflop,
      vs_open: preflop,
      vs_three_bet: preflop,
      gives_up: {
        loose: postflop.tight,
        tight: (w) => sentences(classLine(w, false), w.worth && `A call there is worth ${w.worth} bb a hand.`, spotLine(w)),
      },
      flop_raise: postflop,
      cbet: postflop,
      river_aggression: postflop,
    } as Record<string, { loose: Why; tight: Why }>,
    fallbackWhy: ((w) => sentences(classLine(w, false), spotLine(w))) as Why,
  },
};
