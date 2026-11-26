/**
 * The session review's words, English (`ReviewStrings`, R5.1). Data, like
 * `reports.en.ts`; `review.hr.ts` is the same shape. The grade, street,
 * action and preflop-spot words are the web analysis's own
 * (`web/src/lib/i18n/ns/analysis.en.ts`), so a hand reads the same here
 * and in its Analysis sheet.
 */

const num = (value: number) => value.toLocaleString("en-GB");
/** "1 hand", "1,204 hands". */
const hands = (count: number) => (count === 1 ? "1 hand" : `${num(count)} hands`);

export const reviewUiEn = {
  title: "Session review",
  intro:
    "The hands from one session worth a second look: your worst graded decisions, where you left your preflop charts, and the biggest pots. Each opens in its analysis.",
  loading: "Finding your session…",
  error: (reason: string) => `The session review did not load: ${reason}`,
  noHands: "No session yet: once you have saved hands, your latest session is reviewed here.",
  noMatch: "None of your hands matches this filter, so there is no session to review.",
  hiddenDuringPlay:
    "The session review is hidden while a poker table is open: it is analysis, and analysis is for after you play.",

  picker: {
    label: "Session",
    latest: "Latest finished session",
    option: (day: string, from: string, to: string, count: number) => `${day}, ${from}–${to} · ${hands(count)}`,
    previous: "Previous session",
    next: "Next session",
    gap: (minutes: number) =>
      `A break longer than ${minutes < 60 ? `${minutes} minutes` : `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`} ends a session.`,
    filtered: "Sessions from your Statistics filter.",
    clearFilter: "All hands",
  },

  /**
   * The review of every hand of the filter instead of one session (the
   * desktop app's, #425: the filter row above it, no session picker).
   */
  hands: {
    loading: "Finding your hands…",
    error: (reason: string) => `The hand review did not load: ${reason}`,
    hiddenDuringPlay:
      "The hand review is hidden while a poker table is open: it is analysis, and analysis is for after you play.",
    noHands: "No hands yet: once you have saved hands, the ones worth a second look are here.",
    noMatch: "None of your hands matches this filter.",
    noAnalysed: "None of these hands has been analysed yet.",
    dates: "Played",
    analysedOnly: "Analysed hands only",
    analysed: (analysed: number, total: number) => `${num(analysed)} of ${hands(total)} analysed`,
    empty: {
      worst: "No decision of these hands was graded Inaccurate or worse.",
      deviations: "Every graded preflop decision of these hands follows the charts.",
      pots: "No pot of these hands has a size in big blinds.",
    },
    emptyUnanalysed: "None of these hands is graded yet.",
  },

  ongoing: {
    text: (from: string, to: string) =>
      `Your latest session (${from}–${to}) may still be going on, so the last finished one is shown. The review is for after you play.`,
    reviewNow: "Review it now",
  },
  notFinished: "This session's last hand is under the break ago, so it may still be going on. The review is for after you play.",

  summary: {
    label: "Session summary",
    when: "When",
    hands: "Hands",
    duration: "Length",
    durationValue: (minutes: number) =>
      minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`,
    tables: "Tables",
    result: "Result",
    netBb: "Big blinds",
    bb100: "bb/100",
    evBb: "All-in EV, big blinds",
    evNote: (count: number) =>
      count === 1 ? "1 all-in hand counted at its EV" : `${num(count)} all-in hands counted at their EV`,
    mixedKind: "This session mixes tournament chips with cash, so there is no result to add up.",
    mixedCurrency: "This session spans more than one currency, so the money result is withheld; big blinds add up.",
  },

  coverage: {
    missing: (missing: number, total: number) =>
      `${num(missing)} of the ${hands(total)} in this session ${missing === 1 ? "has" : "have"} not been analysed yet, so ${missing === 1 ? "it is" : "they are"} not in the first two lists.`,
    notAnalysed: (count: number) =>
      count === 1
        ? "1 hand is outside what the analysis covers (multiway, another game, …)."
        : `${num(count)} hands are outside what the analysis covers (multiway, another game, …).`,
    run: "Analyse your hands",
  },

  lists: {
    worst: {
      heading: "Worst decisions",
      description: "Graded Inaccurate or worse, the worst first, then by the EV they cost.",
      empty: "No decision in this session was graded Inaccurate or worse.",
      emptyUnanalysed: "None of this session's hands is graded yet.",
    },
    deviations: {
      heading: "Off your preflop charts",
      description: "Preflop decisions your charts take rarely or never (under 3.5 % of the time), by the EV they cost.",
      empty: "Every graded preflop decision of this session follows the charts.",
      emptyUnanalysed: "None of this session's hands is graded yet.",
    },
    pots: {
      heading: "Biggest pots",
      description: "In big blinds, with your result.",
      empty: "No pot in this session has a size in big blinds.",
    },
    more: (count: number) => (count === 1 ? "1 more is in a list above." : `${num(count)} more are in the lists above.`),
  },

  badges: {
    worst: (rank: number) => `Worst decision #${rank}`,
    deviations: (rank: number) => `Off chart #${rank}`,
    pots: (rank: number) => `Big pot #${rank}`,
  },

  row: {
    open: (cards: string, when: string) => `Open the hand ${cards} from ${when} in its analysis`,
    pot: (bb: string) => `Pot ${bb} bb`,
    result: (bb: string) => `${bb} bb`,
    ev: (bb: string) => `EV ${bb} bb`,
    evLoss: (bb: string) => `−${bb} bb EV`,
    took: (street: string, action: string) => `${street}: ${action}`,
    best: (action: string) => `best: ${action}`,
    chartFreq: (percent: string) => `the chart plays it ${percent} %`,
    noCards: "Cards unknown",
  },

  /** The table layout's column heads (the desktop app). */
  table: {
    time: "Time",
    stakes: "Stakes",
    position: "Pos",
    cards: "Cards",
    board: "Board",
    decision: "Decision",
    grade: "Grade",
    evLoss: "EV lost",
    pot: "Pot",
    result: "Result",
    best: (action: string) => `best ${action}`,
    preflop: "Preflop",
    replayer: (cards: string, when: string) => `Open the hand ${cards} from ${when} in the replayer`,
  },

  grades: {
    perfect: "Perfect",
    good: "Good",
    inaccurate: "Inaccurate",
    mistake: "Mistake",
    blunder: "Blunder",
  } as Record<string, string>,
  streets: { preflop: "Preflop", flop: "Flop", turn: "Turn", river: "River" } as Record<string, string>,
  actions: { fold: "Fold", check: "Check", call: "Call", bet: "Bet", raise: "Raise", allin: "All-in" } as Record<string, string>,

  /** The deviations list read against one of the user's own charts (R5.3). */
  deviationSource: {
    label: "Compare with",
    shipped: "Rail's charts",
    description: (name: string) =>
      `Preflop decisions your chart "${name}" plays rarely or never (under 3.5 % of the time), by the EV Rail's charts put on them.`,
    empty: (name: string) => `Every preflop decision of this session that your chart "${name}" covers follows it.`,
    freq: (percent: string) => `your chart plays it ${percent} %`,
    best: (action: string) => `your chart: ${action}`,
  },
  preflopSpots: {
    unopened: "Unopened pot",
    "vs-limp": "Facing limpers",
    "bb-option": "Big blind option",
    "vs-open": "Facing an open",
    squeeze: "Squeeze spot",
    "vs-3bet": "Facing a 3-bet after opening",
    "vs-3bet-cold": "Facing a 3-bet, cold",
    "vs-4bet": "Facing a 4-bet or more",
    "push-fold": "Push or fold (tournament)",
    "push-fold-call": "Facing a push (tournament)",
  } as Record<string, string>,
};
