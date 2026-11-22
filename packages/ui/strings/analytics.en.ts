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
  /** The screen (Steps 4 and 5): the tabs, the figures row, All stats. */
  screen: {
    tabsLabel: "Analytics",
    tabs: {
      overview: "Overview",
      streets: "Streets",
      stats: "All stats",
      pool: "Pool",
      breakdown: "Breakdown",
    } as Record<string, string>,
    /** The tabs later steps fill: one quiet line each. */
    later: {
      pool: "How your opponents play against your targets: not built yet.",
    } as Record<string, string>,
    figures: {
      label: "Results per 100 hands",
      /** After the hand count: "hands". */
      hands: (count: number): string => (count === 1 ? "hand" : "hands"),
      won: "Won",
      allInEv: "All-in EV",
      showdown: "Showdown",
      nonShowdown: "Non-showdown",
      /** A rate's unit: "bb/100", "$/100". */
      per100: (unit: string) => `${unit}/100`,
      bb: "bb",
      unit: "Show in",
    },
    /** Streets (Step 6): the columns' blocks and the one that is open. */
    streets: {
      /** The block's sample, for its hover: "Times". */
      times: "Times",
      you: "You",
      /** The key in the tab row. */
      raiseBet: "Raise / bet",
      /** An open block's stat against its target: "target 36–42%". */
      target: (range: string) => `target ${range}%`,
      /** A column's name for assistive technology: "Flop: blocks". */
      blocks: (street: string) => `${street}: blocks`,
    },
    /** Overview (Step 7): the findings under the graph, the stats in range, the ways on. */
    overview: {
      findings: "Findings",
      clear: "Nothing clearly off at this sample.",
      unanalysed: "Targets show once your hands are analysed.",
      error: (reason: string) => `The findings did not load: ${reason}`,
      inRange: "In range",
      /** A finding's stat against its target: "target 36–42%". */
      target: (range: string) => `target ${range}%`,
      practise: "Practise this ▸",
      allStats: "All stats →",
      pool: "How your pool plays →",
    },
    graph: "Winnings over hands",
    stats: {
      order: "Order",
      byStreet: "By street",
      byCost: "By cost",
      show: "Show",
      all: "All stats",
      off: "Off target",
      heads: {
        stat: "Stat",
        you: "You",
        track: "Target range · dot = you",
        target: "Target",
        gap: "Gap",
        times: "Times",
      },
      /** The target column: the band, "33–38". */
      range: (low: string, high: string) => `${low}–${high}`,
      /** Under the times when the checker's sample is under 90% of the opportunities. */
      analysed: (share: string) => `${share} analysed`,
      loading: "Checking your stats…",
      error: (reason: string) => `All stats did not load: ${reason}`,
      pending: "Targets fill in as hands are analysed.",
      partial: "All stats follows the dates, the game, one position and one pot type; your other filters are left out here.",
      empty: "No stats at these filters yet.",
      noneOff: "Nothing clearly off target at these filters.",
      noSpots: "No spots to show yet.",
      /** Under the first spots (Overview, Streets): the rest. */
      allSpots: (count: string) => `All ${count} spots`,
      fewerSpots: "Fewer spots",
      spots: {
        spot: "Spot",
        you: "You · fold / call / raise",
        target: "Target",
      },
      key: "Upper bar you · lower bar target",
      bars: {
        fold: "Fold",
        call: "Call",
        raise: "Raise",
        bet: "Bet",
        play: "Play",
        check: "Check",
        other: "Other",
      },
      /** A bar's label for assistive technology: "You: Fold 52%, Call 39%, Raise 9%". */
      /** A spot's gap, its numbers always: "Fold 52% vs 31%". */
      spotGap: (action: string, you: string, target: string) => `${action} ${you} vs ${target}`,
      barLabel: (who: string, parts: string) => `${who}: ${parts}`,
      you: "You",
      target: "Target",
      /** The first hover line: what each stat counts. */
      counts: {
        vpip: "VPIP: every preflop where you put money in on your own: call, bet or raise.",
        pfr: "PFR: every preflop where you raised.",
        rfi: "Open raise: every time it folded to you preflop and you raised first in.",
        three_bet: "3-bet: every time you faced one open raise and raised again.",
        bb_fold_vs_steal: "BB fold vs steal: every steal you faced in the big blind that you folded to.",
        fold_to_three_bet: "Fold to 3-bet: every time your raise was 3-bet and you folded.",
        four_bet: "4-bet: every time you faced a 3-bet and raised again.",
        flop_fold_vs_bet: "Flop fold vs bet: every flop where you faced a bet and folded, whatever happened before.",
        flop_raise_vs_bet: "Flop raise vs bet: every flop where you faced a bet and raised.",
        flop_raise_weak: "Flop raise · weak share: of your flop raises, how many were middle pair or worse.",
        cbet_flop: "Cbet: every flop where you raised preflop, it checked to you and you bet.",
        turn_fold_vs_bet: "Turn fold vs bet: every turn where you faced a bet and folded.",
        turn_fold_vs_probe: "Turn fold vs probe: you raised preflop, the flop checked through, and you folded to a turn bet.",
        turn_barrel: "Barrel: every turn after your flop cbet where you bet again.",
        river_bet: "River bet: every river where no one had bet and you bet.",
        river_bet_weak: "River bet · weak share: of your river bets, how many were third pair or worse.",
        river_fold_vs_bet: "River fold vs bet: every river where you faced a bet and folded.",
        river_raise_vs_bet: "River raise vs bet: every river where you faced a bet and raised.",
        river_raise_weak: "River raise · weak share: of your river raises, how many were middle pair or worse.",
        wtsd: "Went to showdown: of the hands where you saw the flop, how many reached showdown.",
        wsd: "Won at showdown: of the hands that reached showdown, how many you won.",
        wwsf: "Won when saw flop: of the hands where you saw the flop, how many you won.",
      } as Record<string, string>,
      /** The second hover line: where the target comes from. */
      targetFrom: {
        charts: "Target: what the charts do with the hands you held in the same spots.",
        solver: "Target: what Rail's solver does with the hands you held, in the same spots and bet sizes.",
        share: "Target: the solver's own share with the hands you held.",
        none: "No target: this one depends on your opponents' cards as much as on yours.",
      } as Record<string, string>,
    },
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
