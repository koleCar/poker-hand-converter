import { shownPercent } from "../../format";

/**
 * Strings for the Solver library tab (`/solver`), English. Spread into
 * `en.ts` as `solver`; `solver.hr.ts` is the same shape.
 */

const num = (value: number, digits = 0) =>
  value.toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const pct = (value: number) => `${num(Math.round(value * 100))}%`;
/** A share as `shownPercent` rounds it: "4.5%", "52%", "95.5%", "<0.1%", ">99.9%". */
const pct1 = (value: number) => {
  const shown = shownPercent(value);
  return `${shown.bound ?? ""}${num(shown.value, shown.digits)}%`;
};
/** An EV, signed, to two decimals: "+1.25 bb", "−0.40 bb". */
const signedBb = (value: number) => {
  const rounded = Math.round(value * 100) / 100;
  const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "";
  return `${sign}${num(Math.abs(rounded), 2)} bb`;
};
/** Big blinds, to one decimal when there is one: "2.5 bb", "37 bb". */
const bb = (value: number) => {
  const tenth = Math.round(value * 10) / 10;
  return `${num(tenth, tenth % 1 !== 0 ? 1 : 0)} bb`;
};
/** A size without the unit, as on a solver's buttons: "2.5", "13". */
const size = (value: number) => {
  const tenth = Math.round(value * 10) / 10;
  return num(tenth, tenth % 1 !== 0 ? 1 : 0);
};
const tableName = (players: number) => (players === 2 ? "Heads-up" : players === 9 ? "9-max" : "6-max");

export const solverEn = {
  heading: "Solver library",
  intro: "Rail's own solves: build the preflop line seat by seat, pick a flop, and walk the flop's decisions.",
  unavailable: "The solver library is not set up on this server.",
  /** The loader while the table's charts and the library's list of flops arrive. */
  loadingLibrary: "Loading the solver library…",
  /** The loader while a flop's (or a turn's) solve downloads. */
  loadingSolve: "Loading the solve…",
  solvingTurn: (iteration: number, exploitability: number | null) =>
    exploitability === null ? `Solving the turn… ${num(iteration)} iterations` : `Solving the turn… ${num(exploitability, 2)}% of the pot`,
  loadError: "This solve could not be loaded. Try again in a moment.",
  retry: "Try again",

  settings: {
    title: "Table",
    change: "Change",
    players: "Players",
    depth: "Stack depth",
    done: "Done",
    cash: "Cash",
    summary: (players: number, stackBb: number) => `${tableName(players)} · ${num(stackBb)} bb`,
    playersName: tableName,
    depthName: (stackBb: number) => `${num(stackBb)} bb`,
    format: "Format",
    classic: "Classic",
    ante: "Ante",
    straddle: "Straddle",
  },

  preflop: {
    label: "Preflop line",
    stack: size,
    action: (action: string, toBb: number) =>
      action === "raise"
        ? `Raise ${size(toBb)}`
        : (({ fold: "Fold", check: "Check", call: "Call", allin: "All-in" }) as Record<string, string>)[action] ?? action,
    rewind: (position: string) => `Back to ${position}'s decision`,
    show: (position: string) => `Show ${position}'s range here`,
    foldTo: (position: string) => `Everyone before ${position} folds`,
    toAct: "to act",
    folded: (winner: string) => `Everyone folds to ${winner}: there is no flop.`,
    multiway: (players: string) => `A multiway flop (${players}): the library solves heads-up flops only.`,
    allin: "All-in before the flop: there is no flop to solve.",
    uncaptured: "This line is not transcribed from GTO Wizard yet.",
    notSolved: (oop: string, ip: string) => `${ip} vs ${oop}: this line is not in the solver library yet.`,
    setEmpty: "Preflop only: there is no postflop solve for these ranges yet.",
  },

  flop: {
    pick: "Pick a flop",
    change: "Change flop",
    title: "Pick a flop",
    clear: "Clear",
    random: "Random solved flop",
    missing: "The selected flop does not exist.",
    hint: "Pick three cards.",
    slot: "Empty",
    solved: (count: number) => `${num(count)} solved ${count === 1 ? "flop" : "flops"} on this line`,
    card: (card: string, picked: boolean) => `${card}${picked ? ", picked" : ""}`,
  },

  panel: {
    overview: "Overview",
    actions: "Actions",
    hand: "Hand",
    board: "Board",
    pot: (pot: number, toCall: number) => (toCall > 0 ? `Pot ${bb(pot)} · ${bb(toCall)} to call` : `Pot ${bb(pot)}`),
    toAct: (position: string) => `${position} to act`,
    history: "Decisions on the flop",
    start: "Flop",
    step: (position: string, action: string) => `${position} ${action}`,
    follow: (label: string) => `Play ${label}`,
    dealPick: (street: "turn" | "river") => `Pick the ${street} card`,
    street: (street: "turn" | "river", card: string) => `${street === "turn" ? "Turn" : "River"} ${card}`,
    isomorphic: "Cards that play the same up to suits are solved once: a missing suit plays as the one shown.",
    showdown: "The betting is over: the hand goes to showdown.",
    ends: {
      fold: "The hand is over.",
      street: "The turn is dealt: the library keeps the flop's decisions only.",
    },
  },

  action: (kind: string, sizePot: number, amount: number) =>
    kind === "bet"
      ? `Bet ${pct(sizePot)}`
      : kind === "raise"
        ? `Raise ${size(amount)}`
        : (({ fold: "Fold", check: "Check", call: "Call", allin: "All-in" }) as Record<string, string>)[kind] ?? kind,
  share: (share: number, combos: number) => `${pct1(share)} · ${num(Math.round(combos))} combos`,
  shareOnly: pct1,
  combosCount: (combos: number) => `${num(Math.round(combos))} combos`,
  gridLabel: (position: string) => `${position}: the strategy for all 169 hands`,
  cellLabel: (hand: string, parts: string[], absent: boolean) =>
    `${hand}: ${absent ? "not in the range" : parts.join(", ")}`,
  part: (label: string, freq: number) => `${label} ${pct1(freq)}`,
  detailEmpty: "Hover or pick a hand to see what each action is worth.",
  reaches: (reach: number, combos: number) => `${num(reach, 1)} of ${num(combos)} combos reach this decision.`,
  reachesShare: (share: number) => `Reaches this decision with ${pct1(share)} of its combos.`,
  you: "You",
  yourHand: "Your hand",
  comboOff: "Not in this spot",
  inRange: (weight: number) => `${pct1(weight)} in range`,
  tileLabel: (cards: string, parts: string[], value: string) => `${cards}: ${parts.join(", ")}, ${value}`,
  combosLabel: "Combos",
  absent: "Not in the range here.",
  combo: "Combo",
  weight: "Weight",
  ev: "EV",
  value: (value: number) => `EV ${signedBb(value)}`,
  freq: pct1,
  signedBb,
  evShort: (value: number) => num(Math.round(value * 100) / 100 || 0, 2),
  rangeValue: (reach: number, value: number) => `${num(reach, 1)} combos reach this decision · range EV ${signedBb(value)}`,
  solvedTo: (exploitability: number, iterations: number) =>
    `Solved to ${num(exploitability, 2)}% of the pot exploitability in ${num(iterations)} iterations.`,
  chartNote:
    "Preflop: a GTO Wizard solution, transcribed. Where it has several raise sizes, they show as one raise at the most frequent size. Cells fade where less of the hand reaches the decision.",
  fullNote: "Full solve: flop, turn and river (local). ",
  liveNote: "Turn and river solved here from the flop's ranges: turn 75% and all-in, one raise; river 75% and all-in. ",
  flopNote: "A cell fades where less of the hand reaches the decision. Combos are shown in the suits of the picked flop.",

  tabs: { label: "View", strategy: "Strategy + EV", ranges: "Ranges" },

  ranges: {
    modes: { strategy: "Strategy", ev: "EV", equity: "Equity", range: "Range", eqr: "EQR" },
    mode: (position: string) => `What ${position}'s grid shows`,
    gridLabel: (position: string, mode: string) => `${position}'s range by ${mode.toLowerCase()}`,
    cellLabel: (hand: string, combos: number, value: string | null) =>
      `${hand}: ${combos > 0 ? `${num(combos, 1)} combos${value ? `, ${value}` : ""}` : "not in the range"}`,
    compare: "Both ranges",
    combos: "Combos",
    ev: "EV",
    equity: "Equity",
    /** The loader in the equity row while it is worked out (a moment, off the click). */
    equityLoading: "Working out equity…",
    eqr: "EQR",
    groups: { made: "Hands", draw: "Draws", eq: "EQ buckets", band: "EQ buckets – advanced" },
    groupPick: "Categories to compare",
    chart: "Equity chart",
    chartLabel: (a: string, b: string) =>
      `Equity of every combo of ${a} and ${b}, weakest first; across, the share of the range`,
    computing: "Computing equity…",
    noEv: "–",
    noEvNote: (position: string) => `${position}'s EV is not stored right after a dealt card.`,
    hover: (hand: string, position: string, combos: number, equity: number | null, ev: number | null) =>
      `${hand} · ${position}: ${num(combos, 1)} combos` +
      (equity === null ? "" : ` · equity ${pct1(equity)}`) +
      (ev === null ? "" : ` · EV ${num(ev, 2)} bb`),
    hoverEmpty: "Hover a hand to see its combos, equity and EV.",
    cellValue: {
      strategy: () => "",
      ev: (value: number) => num(value, 1),
      equity: (value: number) => num(Math.round(value * 100)),
      range: (value: number) => num(value, 1),
      eqr: (value: number) => num(Math.round(value * 100)),
    },
    bb: (value: number) => num(value, 2),
    share: pct1,
    /** EQR goes past 100%: not a share, so not capped. */
    eqrValue: (value: number) => pct(value),
    ofFiltered: (share: number) => `${pct1(share)} of the range`,
    note: "EV is what the hand takes back out of the pot (the two add up to the pot, less rake); EQR is EV over equity times the pot.",
  },

  filters: {
    hand: "Hand",
    title: "Filters",
    include: "Include",
    exclude: "Exclude",
    clear: "Clear",
    offsuit: "Offsuit",
    suited: "Suited",
    suit: (suit: string, suited: boolean) => (suited ? `Suited ${suit}${suit}` : `Offsuit with a ${suit}`),
    andAbove: (label: string) => `${label} and everything above it`,
    forPlayer: (position: string) => `Shares of ${position}'s range at this decision`,
    groups: { made: "Hands", draw: "Draws", eq: "EQ buckets – simple", band: "EQ buckets – advanced" },
    made: {
      straightFlush: "Straight flush",
      quads: "Quads",
      fullHouse: "Full house",
      flush: "Flush",
      straight: "Straight",
      set: "Set",
      trips: "Trips",
      twoPair: "Two pair",
      overpair: "Overpair",
      topPair: "Top pair",
      secondPair: "Second pair",
      thirdPair: "Third pair",
      weakPair: "Weak pair",
      underpair: "Underpair",
      aceHigh: "Ace high",
      kingHigh: "King high",
      nothing: "No made hand",
    },
    draw: {
      comboDraw: "Flush + straight draw",
      flushDraw: "Flush draw",
      oesd: "OESD",
      gutshot: "Gutshot",
      bdfd2: "BDFD 2 cards",
      bdfd1: "BDFD 1 card",
      bdsd: "BDSD",
      noDraw: "No draw",
    },
    eq: { best: "Best hands", good: "Good hands", weak: "Weak hands", trash: "Trash hands" },
    eqHint: "By equity: best 100–75%, good 75–50%, weak 50–33%, trash 33–0%.",
    band: (from: string) => (from === "90" ? "Equity 90–100" : from === "25" ? "Equity 25–50" : from === "0" ? "Equity 0–25" : `Equity ${from}–${Number(from) + 10}`),
    share: pct1,
    active: (mode: "include" | "exclude") => (mode === "include" ? "Only" : "Without"),
    remove: (label: string) => `Remove ${label}`,
    note: (combos: number, share: number) => `Filter: ${num(combos, 1)} combos, ${pct1(share)} of the range.`,
    none: "Nothing in the range passes the filter.",
  },
} as const;
