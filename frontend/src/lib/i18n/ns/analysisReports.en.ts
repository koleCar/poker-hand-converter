/**
 * Strings for the Analysis tab's Reports (`/analysis/reports`, phase A3),
 * English. Spread into `analysis.en.ts` as `analysis.reports`;
 * `analysisReports.hr.ts` is the same shape.
 *
 * Numbers arrive as fractions (0–1) and are formatted here, so the two
 * languages can place the percent sign and the decimal comma their own way.
 */

const num = (value: number, digits = 0) =>
  value.toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const hands = (count: number) => `${num(count)} ${count === 1 ? "hand" : "hands"}`;
const decisions = (count: number) => `${num(count)} ${count === 1 ? "decision" : "decisions"}`;
/** A share: one decimal under 10%, whole above. */
const pct = (value: number) => {
  const p = value * 100;
  return p > 0 && p < 10 ? `${num(Math.round(p * 10) / 10, 1)}%` : `${num(Math.round(p))}%`;
};
/** A signed gap in percentage points: "+6.4 pts", "−12 pts". */
const points = (value: number) => {
  const p = Math.round(value * 1000) / 10;
  const sign = p > 0 ? "+" : p < 0 ? "−" : "±";
  const abs = Math.abs(p);
  return `${sign}${num(abs, abs > 0 && abs < 10 ? 1 : 0)} pts`;
};
const bb = (value: number) => `${num(value, 2)} bb`;

const actions = { fold: "Fold", check: "Check", call: "Call", raise: "Raise", allin: "All-in" } as Record<string, string>;

export const reportsEn = {
  heading: "Reports",
  intro:
    "How often you take each action at the preflop spots the charts cover, next to how often the reference does — and the hands where you left it, the costliest first.",
  loading: "Reading your decisions…",
  loadingCharts: "Loading the charts…",
  chartsFailed: (message: string) => `The charts did not load: ${message}`,
  notInstalledHeading: "Reports are not set up on this database yet",
  /** Around the migration file name, shown in `<code>`. */
  notInstalledBefore: "They arrive with ",
  notInstalledAfter: ". Apply it and reload.",
  emptyHeading: "Nothing graded yet",
  emptyBody:
    "Reports compare your graded preflop decisions with the charts. Run the analysis on your hands first; it grades every decision the charts cover.",
  goToAnalysis: "Go to your analysis",
  noneInScope: "No graded preflop decision matches these filters.",
  sample: (count: number, handCount: number) => `${decisions(count)} graded, in ${hands(handCount)}`,
  unmatched: (count: number) =>
    `${decisions(count)} were graded at spots this chart set does not have any more; they are left out until you re-run the analysis.`,

  filters: {
    ariaLabel: "Report filters",
    from: "From",
    to: "To",
    room: "Room",
    anyRoom: "Every room",
    stake: "Stakes",
    anyStake: "Every stake",
    stakeOption: (label: string, count: number) => `${label} (${num(count)})`,
    unknownStake: "Unknown stakes",
    position: "Position",
    anyPosition: "Every position",
    clear: "Clear filters",
  },

  how: {
    toggle: "How to read this",
    title: "Two references, and when a gap means something",
    range:
      "Reference: how often the charts take the action over the whole range that reaches the spot — every hand weighted by its combos and by how often the reference gets there with it. Holding a hand changes how likely the earlier players' actions were (an opener holds more aces), so each hand is also weighted by the opponents' ranges, card by card; the charts' own model, opponents taken as independent of each other.",
    adjusted:
      "Your hands: what the charts do with the hands you actually held at the spot, averaged over your decisions. Your hands are not dealt from the reference's range — you reach a 3-bet with your own opening range — and over a few dozen hands even a perfect player's frequency drifts from the range's by the luck of the deal. This column has neither problem: if you play every hand the way the chart does, it equals yours exactly.",
    verdict:
      "In line: the reference sits inside the 95% interval of your frequency, or the gap is under 2 points. Deviates: it is outside, by more. Too few: under 10 decisions, where any frequency is possible.",
    sample:
      "Each stat adds up spots. Its reference weights every spot by your decisions there, so your RFI is compared with the charts' RFI for the seats you actually opened from.",
    mixed:
      "A hand the reference plays two ways is Perfect either way in the hand list; it is here, over many hands, that always picking one side shows.",
    model:
      "The reference is Rail's own charts (charts/4: 6-max and full ring, 40 to 200 bb, limped pots included), each decision against the set that graded it. They still under-rate hands that win through implied odds a little, so they flat and open small pairs and suited connectors less than most players do. In a limped pot the reference's limper may hold any hand.",
  },

  columns: {
    stat: "Stat",
    spot: "Spot",
    split: "Seat",
    decisions: "Decisions",
    yours: "You",
    reference: "Reference",
    adjusted: "Your hands",
    diff: "Difference",
    verdict: "Verdict",
    action: "Action",
    whatIsAdjusted: "What do the two references mean?",
  },

  verdicts: { "in-line": "In line", deviates: "Deviates", "too-few": "Too few" } as Record<string, string>,
  interval: (low: number, high: number) => `95%: ${pct(low)}–${pct(high)}`,
  pct,
  points,
  bb,
  actions,
  /** "BB vs BTN", "CO". */
  splitLabel: (position: string, versus: string | null) => (versus ? `${position} vs ${versus}` : position),
  expand: (name: string) => `Show details: ${name}`,
  collapse: (name: string) => `Hide details: ${name}`,
  /** Screen-reader summary of one comparison. */
  summary: (yours: string, reference: string, verdict: string) => `You ${yours}, reference ${reference}: ${verdict}`,
  noDecisions: "No decisions yet",

  /** The chart set filter (A2d). */
  sets: {
    label: "Charts",
    all: (count: number) => `All ${num(count)} tables and depths`,
    /** "6-max, 100bb · 1,689 decisions". */
    option: (name: string, decisions: string) => `${name} · ${decisions}`,
    note: "Every decision is compared with the chart set that graded it; a stat across sets weighs each set's reference by your decisions there.",
    /** "UTG vs CO · 9-max". */
    tableTag: (label: string, table: number) => `${label} · ${table}-max`,
    nodeTag: (spot: string, set: string) => `${spot} (${set})`,
  },

  stats: {
    heading: "Your stats against the reference",
    note: "The familiar preflop stats, added up from the chart spots behind them. Open a row for its seats and the hands where you left the reference.",
    bySplit: "By seat",
    names: {
      rfi: "Raise first in",
      steal: "Steal",
      "three-bet": "3-bet against an open",
      "blind-defence": "Blind defence",
      "fold-to-steal": "Fold to a steal",
      "fold-to-three-bet-ip": "Fold to a 3-bet, in position",
      "fold-to-three-bet-oop": "Fold to a 3-bet, out of position",
      "four-bet": "4-bet",
      squeeze: "Squeeze",
      iso: "Isolation raise",
    } as Record<string, string>,
    definitions: {
      rfi: "Everyone before you folded and you raised. The small blind's limp is not an open.",
      steal: "An open from the cutoff, the button or the small blind, with only the blinds left to act.",
      "three-bet": "You re-raised a single open that nobody had called. With callers in between it is a squeeze.",
      "blind-defence": "In a blind against a single open, you called or 3-bet instead of folding.",
      "fold-to-steal": "In a blind against an open from the cutoff, button or small blind, you folded.",
      "fold-to-three-bet-ip":
        "You opened, were 3-bet by a player you act after on the flop, and folded.",
      "fold-to-three-bet-oop":
        "You opened, were 3-bet by a player who acts after you on the flop, and folded.",
      "four-bet": "You re-raised a 3-bet — as the opener, a caller or cold.",
      squeeze: "You re-raised an open that one or more players had called.",
      iso: "You raised over one or more limpers, nobody having raised (the reference's limpers may hold any hand: it models a limp as a mistake anyone can make).",
    } as Record<string, string>,
    tips: {
      rfi: "Width should grow seat by seat to the button. A gap at one seat is usually a few hand classes — open the seat's row and read the hands.",
      steal: "The blinds defend wide against a late open, but out of position. Folding too often here hands them the blinds for free.",
      "three-bet": "Against a late open you 3-bet more, and with more bluffs that block the opener's continuing hands.",
      "blind-defence": "The big blind closes the action and gets a price; most defence there is a call. The small blind, out of position against everyone, mostly 3-bets or folds.",
      "fold-to-steal": "Above the reference you are paying the blinds every orbit; far below it you defend hands that lose more than the blind.",
      "fold-to-three-bet-ip": "In position you can call wider: you realise more of your equity after the flop.",
      "fold-to-three-bet-oop": "Out of position calls realise less; fold more, or 4-bet the top and a few blockers.",
      "four-bet": "4-bets are mostly the top of the range and a few blockers (an ace) that do not call well.",
      squeeze: "Callers cap their ranges; squeeze bigger than a 3-bet and with hands that play well as a raise.",
      iso: "Limpers are weak and wide: isolate more often in position and from later seats, bigger with more limpers, and over-limp the hands that want a cheap multiway flop.",
    } as Record<string, string>,
  },

  defence: {
    heading: "Blind defence against each opener",
    note: "From the small blind and the big blind against a single open: how often you fold, call and 3-bet. Each cell is your frequency, with the reference's under it.",
    fold: "Fold",
    call: "Call",
    threeBet: "3-bet",
    /** One cell: "You 62% · ref 55%". */
    cell: (yours: string, reference: string) => `${yours} · ${reference}`,
    cellLabel: (action: string, yours: string, reference: string, verdict: string) =>
      `${action}: you ${yours}, reference ${reference}, ${verdict}`,
  },

  nodes: {
    heading: "Spot by spot",
    note: "Every chart spot where you have graded decisions, most decisions first. Open one for every action against both references, and the hands where you left it.",
    category: "Scenario",
    allCategories: "Every scenario",
    showAll: (count: number) => `Show all ${num(count)} spots`,
    showFewer: "Show fewer",
    decisions,
    widest: (action: string, yours: string, reference: string) => `${action} ${yours} · reference ${reference}`,
    study: "Study this spot in the charts",
    noneInCategory: "No graded decisions in this scenario.",
  },

  hands: {
    heading: "Where you left the reference",
    note: "Decisions graded worse than Perfect, most EV lost first.",
    loading: "Loading the hands…",
    empty: "None — every graded decision here was Perfect.",
    more: "Show more",
    total: (count: number) => `${decisions(count)}`,
    open: (cards: string) => `Open the hand ${cards} in its analysis`,
    took: (action: string) => `You: ${action}`,
    better: (action: string, freq: string) => `Reference: ${action} ${freq}`,
    evLoss: (value: number) => `−${bb(value)}`,
    failed: (message: string) => `The hands did not load: ${message}`,
  },

  postflop: {
    heading: "After the flop, by role",
    note: "Your own frequencies in heads-up pots, by whether you raised preflop or called, and whether you act last on the flop. Limped and multiway pots are left out.",
    placeholder:
      "No reference yet: postflop frequencies need a solved flop for every board, and that arrives with the flop library (phase A5). Until then these are your numbers, to watch over time.",
    streets: { flop: "Flop", turn: "Turn", river: "River" } as Record<string, string>,
    streetLabel: "Street",
    role: "Role",
    roles: {
      "pfr-ip": "Preflop raiser, in position",
      "pfr-oop": "Preflop raiser, out of position",
      "caller-ip": "Preflop caller, in position",
      "caller-oop": "Preflop caller, out of position",
    } as Record<string, string>,
    betFirst: "Bet when first or checked to",
    betFirstHint: { pfr: "the c-bet", callerIp: "a stab", callerOop: "a donk bet" },
    foldVsBet: "Fold to a bet",
    callVsBet: "Call a bet",
    raiseVsBet: "Raise a bet",
    of: (count: number) => `of ${num(count)}`,
    empty: "No heads-up decisions on this street in the sample.",
  },
} as const;
