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

export const solverEn = {
  heading: "Solver library",
  intro:
    "Rail's own flop solves. Pick a table, a preflop line and a flop, then walk the flop's decisions: every hand shows how often the solver takes each action and what each action is worth.",
  signedOut: {
    title: "Sign in to open the solver library",
    body: "The solver library is for signed-in players. Sign in and every solved flop is one click away.",
    cta: "Sign in",
  },
  unavailable: "The solver library is not set up on this server.",
  table: "Table",
  setName: (players: number, stackBb: number) =>
    `${players === 2 ? "Heads-up" : players === 9 ? "9-max" : "6-max"} ${num(stackBb)} bb`,
  setEmpty: "This table's solves are not published yet.",
  line: "Preflop line",
  pots: { srp: "single-raised pot", "3bp": "3-bet pot", "4bp": "4-bet pot", limped: "limped pot" } as Record<string, string>,
  lineName: (oop: string, ip: string, pot: string) => `${ip} vs ${oop} · ${pot}`,
  flop: "Flop",
  flopCount: (count: number) => `${num(count)} solved ${count === 1 ? "flop" : "flops"}`,
  textures: {
    all: "All",
    rainbow: "Rainbow",
    twoTone: "Two-tone",
    monotone: "Monotone",
    paired: "Paired",
    trips: "Trips",
  },
  flopsLabel: "Solved flops",
  loading: "Loading…",
  loadError: "This solve could not be loaded. Try again in a moment.",
  retry: "Try again",
  board: "Board",
  toAct: (position: string) => `${position} to act`,
  pot: (pot: number, toCall: number) => (toCall > 0 ? `Pot ${bb(pot)}, ${bb(toCall)} to call` : `Pot ${bb(pot)}`),
  history: "Decisions so far",
  start: "Flop",
  step: (position: string, action: string) => `${position} ${action}`,
  action: (kind: string, sizePot: number, amount: number) =>
    kind === "bet"
      ? `Bet ${pct(sizePot)}`
      : kind === "raise"
        ? `Raise ${bb(amount)}`
        : (({ fold: "Fold", check: "Check", call: "Call", allin: "All-in" }) as Record<string, string>)[kind] ?? kind,
  actionsLabel: "Actions",
  total: (label: string, share: number, combos: number) => `${label} ${pct1(share)} · ${num(Math.round(combos))} combos`,
  share: (share: number, combos: number) => `${pct1(share)} · ${num(Math.round(combos))} combos`,
  follow: (label: string) => `Play ${label}`,
  ends: {
    fold: "The hand is over.",
    street: "The turn is dealt: the library keeps the flop's decisions only.",
  },
  gridLabel: (position: string) => `${position}: the solver's mix for all 169 hands`,
  cellLabel: (hand: string, parts: string[], absent: boolean) =>
    `${hand}: ${absent ? "not in the range" : parts.join(", ")}`,
  part: (label: string, freq: number) => `${label} ${pct1(freq)}`,
  detailEmpty: "Hover or pick a hand to see its combos.",
  reaches: (reach: number, combos: number) => `${num(reach, 1)} of ${num(combos)} combos reach this decision.`,
  absent: "Not in the range here.",
  combo: "Combo",
  weight: "Weight",
  ev: "EV",
  value: (value: number) => `EV ${signedBb(value)}`,
  freq: pct1,
  signedBb,
  rangeValue: (reach: number, value: number) => `${num(reach, 1)} combos reach this decision · range EV ${signedBb(value)}`,
  solvedTo: (pct: number, iterations: number) =>
    `Solved to ${num(pct, 2)}% of the pot exploitability in ${num(iterations)} iterations.`,
  rangeNote: "A cell fades where less of the hand reaches the decision. Cards are in the solve's own suits.",
} as const;
