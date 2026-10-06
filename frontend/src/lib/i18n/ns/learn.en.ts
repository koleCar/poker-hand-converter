/**
 * Strings for the concept library (`/analysis/learn`), English. Spread into
 * `en.ts` as `learn`; `learn.hr.ts` is the same shape.
 *
 * Only the short strings live here: the concept titles (the Analysis sheet
 * links to a concept by name, client-side), the page chrome and the labels of
 * the interactive examples. The page bodies — definitions, examples, mistakes
 * — are in `lib/learn/content/`, read by the server only, so tens of
 * kilobytes of prose do not ride along in every screen's dictionary.
 *
 * Numbers arrive here already formatted for the reader's locale (`Intl`, in
 * the widget), so these functions only place them in a sentence.
 */

const titles = {
  "pot-odds": "Pot odds",
  "equity-realisation": "Equity and equity realisation",
  "ev-and-grading": "EV, EV loss and how Rail grades",
  "gto-vs-exploitative": "GTO and exploitative play",
  position: "Position",
  ranges: "Ranges",
  "range-advantage": "Range advantage",
  "nut-advantage": "Nut advantage",
  "board-texture": "Board texture",
  "dynamic-boards": "Dynamic and static boards",
  blockers: "Blockers and unblockers",
  spr: "SPR and commitment",
  "mdf-alpha": "MDF and alpha",
  "bet-sizing": "Bet sizing and polarisation",
  "continuation-bet": "Continuation betting",
  "check-raise": "Check-raising",
  "donk-bet": "Donk betting",
  "bluff-catching": "Bluff-catching",
  "thin-value": "Thin value betting",
  "multiway-pots": "Multiway pots",
  rfi: "Raise first in (RFI)",
  "three-bet": "3-bets and 4-bets",
  squeeze: "Squeezing",
  "blind-defence": "Blind defence",
  steal: "Stealing the blinds",
} as Record<string, string>;

export const learnEn = {
  /** The Analysis tab's own navigation — not a top-level tab. */
  nav: {
    label: "Analysis sections",
    overview: "Your analysis",
    train: "Train",
    plan: "Plan",
    leaks: "Leaks",
    progress: "Progress",
    reports: "Reports",
    charts: "Charts",
    learn: "Concepts",
    more: "More",
  },

  titles,

  index: {
    heading: "Concepts",
    intro:
      "The ideas behind every explanation in your analysis: what each one means, the maths where there is some, a worked example and something to try. Every link in an explanation lands on one of these pages.",
    groups: {
      foundations: "Foundations",
      ranges: "Ranges and boards",
      betting: "Betting",
      preflop: "Preflop",
    } as Record<string, string>,
    interactive: "Interactive",
  },

  page: {
    breadcrumb: "Concepts",
    backToIndex: "All concepts",
    definition: "What it is",
    why: "Why it matters",
    formulas: "The maths",
    where: "Where",
    example: "Worked example",
    mistakes: "Common mistakes",
    tryIt: "Try it",
    related: "Related concepts",
    yourHands: "In your hands",
    yourHandsBody: "Hands from your library where the analysis flagged this:",
    handsWithFlag: (flag: string) => `Hands flagged “${flag}”`,
    yourHandsNote: "Opens your analysis, filtered. You need to be signed in; nobody else sees your hands.",
  },

  /** The link an explanation carries to a concept. */
  learnLabel: "Learn",
  learnLink: (title: string) => `Learn: ${title}`,

  widgets: {
    illustrative: "Illustrative ranges, written by hand for teaching — not solved.",
    pot: "Pot",
    potIncludingBet: "Pot, including the bet you face",
    potBeforeBet: "Pot before the bet",
    potBeforeRaise: "Pot before your raise",
    blinds: "Blinds and antes in the middle",
    toCall: "To call",
    bet: "Bet",
    raise: "Your bet or raise",
    open: "Your open (chips risked)",
    yourEquity: "Your equity",
    foldRate: "How often they fold",
    bb: (value: string) => `${value} bb`,
    ofPot: (value: string) => `${value} of the pot`,
    ratio: (value: string) => `${value} to 1`,

    requiredEquity: "Equity needed",
    potOdds: "Pot odds",
    callEv: "EV of calling",
    alpha: "Alpha: folds needed",
    mdf: "MDF: defend at least",
    callerPrice: "Caller needs",
    bluffShare: "Bluffs in a polarised bet",
    valuePerBluff: "Value hands per bluff",
    bluffEv: "EV if it never wins when called",
    evPositive: "Profitable",
    evNegative: "Losing",
    evZero: "Break-even",

    sizingTable: {
      caption: "Common bet sizes, with the pot before the bet as 100%. What the caller needs is also the bluff share of a polarised bet.",
      size: "Bet",
      alpha: "Alpha",
      mdf: "MDF",
      price: "Caller needs",
    },

    spr: {
      stack: "Effective stack",
      streets: "Streets to bet",
      spr: "SPR",
      geometric: "Geometric bet each street",
      potBets: "Called pot-sized bets the stacks hold",
      streetCount: (count: number) => (count === 1 ? "1 street" : `${count} streets`),
    },

    cards: {
      board: "Board",
      hand: "Your hand",
      pickBoard: "Pick 3 to 5 board cards",
      pickHand: "Pick your two cards",
      clear: "Clear",
      random: "Random flop",
      presets: "Examples",
      suitRow: (suit: string) => `${suit}`,
      selected: (cards: string) => (cards ? `Selected: ${cards}` : "Nothing selected"),
      noBoard: "No board (preflop)",
    },

    texture: {
      needCards: "Pick at least three cards to read the board.",
      paired: "Paired",
      trips: "Trips on board",
      unpaired: "Unpaired",
      suits: { rainbow: "Rainbow", "two-tone": "Two-tone", monotone: "Monotone" } as Record<string, string>,
      connectedness: {
        disconnected: "Disconnected",
        "semi-connected": "Semi-connected",
        connected: "Connected",
      } as Record<string, string>,
      highCard: { ace: "Ace-high", broadway: "Broadway", middle: "Middling", low: "Low" } as Record<string, string>,
      dynamism: { static: "Static", medium: "Medium", dynamic: "Dynamic" } as Record<string, string>,
      straightCombos: "Two-card straights",
      flushPossible: "Flush possible",
      straightPossible: "Straight possible",
      yes: "Yes",
      no: "No",
      volatility: "Volatility",
      volatilityHint: "Share of next cards that change the board (overcards count half)",
      river: "River: no next card, so neither static nor dynamic.",
      thresholds: "Static below 25%, dynamic from 45%",
    },

    equity: {
      range: "Opponent's range",
      ranges: {
        "open-utg": "Under-the-gun open",
        "open-btn": "Button open",
        "call-bb": "Big-blind call",
        "call-bb-vs-utg": "Big-blind call against UTG",
        "3bet": "3-bet",
        "call-3bet": "Call of a 3-bet",
        "4bet": "4-bet",
      } as Record<string, string>,
      raw: "Raw equity",
      realisation: "Realisation",
      realised: "Realised equity",
      combos: (count: number, formatted: string) => `${formatted} ${count === 1 ? "combo" : "combos"} in the range after card removal`,
      priceLabel: "Price to compare",
      needHand: "Pick two cards for your hand.",
      emptyRange: "Card removal leaves no combos in that range.",
      sampled: "Estimated by sampling with a fixed seed",
    },

    rvr: {
      matchup: "Matchup",
      matchups: {
        "btn-vs-bb": "Button open vs big-blind call",
        "utg-vs-bb": "UTG open vs big-blind call",
        "3bet-vs-call": "3-bet vs call",
      } as Record<string, string>,
      raiser: "Raiser",
      caller: "Caller",
      equity: "Range equity",
      nuts: "In the top 10% of hands",
      needFlop: "Pick a flop (or a preset) to compare the ranges on a board.",
    },

    combos: {
      preset: "Their range",
      presets: {
        premium: "QQ+ and AK",
        broadway: "AK, AQ, KQ",
        "wheel-aces": "A5s–A2s",
        "sets-k72": "KK, 77, 22",
      } as Record<string, string>,
      class: "Hand",
      total: "Combos",
      left: "Left",
      sum: "Total",
      removed: (share: string) => `Your cards and the board remove ${share} of these combos.`,
    },

    grading: {
      pot: "Pot before the decision",
      option: "Option",
      freq: "Reference frequency",
      ev: "EV (bb)",
      chosen: "You played",
      fold: "Fold",
      call: "Call",
      raise: "Raise",
      foldRest: "Fold takes the rest",
      grade: "Grade",
      evLoss: "EV loss",
      evLossPot: "of the pot",
      score: "Score",
      evLabel: (option: string) => `EV of ${option.toLowerCase()} in bb`,
      freqLabel: (option: string) => `Reference frequency of ${option.toLowerCase()}`,
    },

    bluffCatcher: {
      bluffs: "Their bluff share",
      indifferent: "Indifferent at",
      ev: "EV of calling",
      verdict: { call: "Call", fold: "Fold", either: "Either" } as Record<string, string>,
    },

    valueBet: {
      callRate: "How often they call",
      beatShare: "Share of calls you beat",
      gain: "Gain over checking",
      verdict: { bet: "Bet", check: "Check", either: "Either" } as Record<string, string>,
    },
    multiway: {
      opponents: "Opponents the bet goes into",
      opponentCount: (count: number) => (count === 1 ? "1 opponent" : `${count} opponents`),
      foldEach: "How often each one folds",
      allFold: "Everyone folds",
      needed: "Folds the bet needs (alpha)",
      bluffEv: "EV of a pure bluff",
      mdfHeadsUp: "Heads-up defence (MDF)",
      mdfEach: "Each defender needs to continue",
      verdict: { bet: "Profitable bluff", check: "Losing bluff", either: "Break-even" } as Record<string, string>,
    },
  },
} as const;
