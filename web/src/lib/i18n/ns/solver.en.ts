/**
 * Strings for the Solver library tab (`/solver`), English. Spread into
 * `en.ts` as `solver`; `solver.hr.ts` is the same shape.
 */

const num = (value: number, digits = 0) =>
  value.toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const pct = (value: number) => `${num(Math.round(value * 100))}%`;
/** A share to one decimal under 10%, whole above: "4.5%", "52%". */
const pct1 = (value: number) => {
  const p = value * 100;
  return p > 0 && p < 10 ? `${num(Math.round(p * 10) / 10, 1)}%` : `${num(Math.round(p))}%`;
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
  loading: "Loading…",
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
  },

  preflop: {
    label: "Preflop line",
    stack: size,
    action: (action: string, toBb: number) =>
      action === "raise"
        ? `Raise ${size(toBb)}`
        : (({ fold: "Fold", check: "Check", call: "Call", allin: "All-in" }) as Record<string, string>)[action] ?? action,
    rewind: (position: string) => `Back to ${position}'s decision`,
    toAct: "to act",
    folded: (winner: string) => `Everyone folds to ${winner}: there is no flop.`,
    multiway: (players: string) => `A multiway flop (${players}): the library solves heads-up flops only.`,
    allin: "All-in before the flop: there is no flop to solve.",
    notSolved: (oop: string, ip: string) => `${ip} vs ${oop}: this line is not in the solver library yet.`,
    setEmpty: "This table's flop solves are not published yet.",
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
  chartNote: "Preflop: Rail's own charts. Cells fade where less of the hand reaches the decision.",
  flopNote: "A cell fades where less of the hand reaches the decision. Combos are shown in the suits of the picked flop.",
} as const;
