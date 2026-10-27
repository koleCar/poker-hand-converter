import { plural } from "../plural";
import type { Dict } from "../types";

/**
 * Strings for the Solver library tab (`/solver`), Croatian. Same shape as
 * `solver.en.ts`.
 */

const num = (value: number, digits = 0) =>
  value.toLocaleString("hr-HR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const pct = (value: number) => `${num(Math.round(value * 100))} %`;
const pct1 = (value: number) => {
  const p = value * 100;
  return p > 0 && p < 10 ? `${num(Math.round(p * 10) / 10, 1)} %` : `${num(Math.round(p))} %`;
};
const signedBb = (value: number) => {
  const rounded = Math.round(value * 100) / 100;
  const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "";
  return `${sign}${num(Math.abs(rounded), 2)} bb`;
};
const bb = (value: number) => {
  const tenth = Math.round(value * 10) / 10;
  return `${num(tenth, tenth % 1 !== 0 ? 1 : 0)} bb`;
};
/** 1 kombinacija, 2 kombinacije, 5 kombinacija. */
const combos = (count: number) => `${num(count)} ${plural(count, "kombinacija", "kombinacije", "kombinacija")}`;

export const solverHr: Dict["solver"] = {
  heading: "Solver library",
  intro:
    "Railovi vlastiti flop solvovi. Odaberi stol, preflop liniju i flop, pa prođi kroz odluke na flopu: za svaku ruku vidiš koliko često solver bira koju akciju i koliko svaka akcija vrijedi.",
  signedOut: {
    title: "Prijavi se da otvoriš solver library",
    body: "Solver library je za prijavljene igrače. Prijavi se i svaki solvani flop udaljen je jedan klik.",
    cta: "Prijava",
  },
  unavailable: "Solver library nije postavljen na ovom serveru.",
  table: "Stol",
  setName: (players: number, stackBb: number) =>
    `${players === 2 ? "Heads-up" : players === 9 ? "9-max" : "6-max"} ${num(stackBb)} bb`,
  setEmpty: "Solvovi za ovaj stol još nisu objavljeni.",
  line: "Preflop linija",
  pots: { srp: "single-raised pot", "3bp": "3-bet pot", "4bp": "4-bet pot", limped: "limpani pot" },
  lineName: (oop: string, ip: string, pot: string) => `${ip} protiv ${oop} · ${pot}`,
  flop: "Flop",
  flopCount: (count: number) => `${num(count)} ${plural(count, "solvani flop", "solvana flopa", "solvanih flopova")}`,
  textures: {
    all: "Svi",
    rainbow: "Rainbow",
    twoTone: "Two-tone",
    monotone: "Monotone",
    paired: "Upareni",
    trips: "Trips",
  },
  flopsLabel: "Solvani flopovi",
  loading: "Učitavanje…",
  loadError: "Ovaj solve se nije mogao učitati. Pokušaj ponovno za trenutak.",
  retry: "Pokušaj ponovno",
  board: "Board",
  toAct: (position: string) => `Na potezu: ${position}`,
  pot: (pot: number, toCall: number) => (toCall > 0 ? `Pot ${bb(pot)}, ${bb(toCall)} za call` : `Pot ${bb(pot)}`),
  history: "Dosadašnje odluke",
  start: "Flop",
  step: (position: string, action: string) => `${position} ${action}`,
  action: (kind: string, sizePot: number, amount: number) =>
    kind === "bet"
      ? `Bet ${pct(sizePot)}`
      : kind === "raise"
        ? `Raise ${bb(amount)}`
        : (({ fold: "Fold", check: "Check", call: "Call", allin: "All-in" }) as Record<string, string>)[kind] ?? kind,
  actionsLabel: "Akcije",
  total: (label: string, share: number, count: number) => `${label} ${pct1(share)} · ${combos(Math.round(count))}`,
  share: (share: number, count: number) => `${pct1(share)} · ${combos(Math.round(count))}`,
  follow: (label: string) => `Odigraj ${label}`,
  ends: {
    fold: "Ruka je gotova.",
    street: "Dijeli se turn: knjižnica čuva samo odluke na flopu.",
  },
  gridLabel: (position: string) => `${position}: solverov mix za svih 169 ruku`,
  cellLabel: (hand: string, parts: string[], absent: boolean) => `${hand}: ${absent ? "nije u rasponu" : parts.join(", ")}`,
  part: (label: string, freq: number) => `${label} ${pct1(freq)}`,
  detailEmpty: "Pređi mišem ili odaberi ruku da vidiš njezine kombinacije.",
  reaches: (reach: number, count: number) => `${num(reach, 1)} od ${combos(count)} dolazi do ove odluke.`,
  absent: "Ovdje nije u rasponu.",
  combo: "Kombinacija",
  weight: "Težina",
  ev: "EV",
  value: (value: number) => `EV ${signedBb(value)}`,
  freq: pct1,
  signedBb,
  rangeValue: (reach: number, value: number) =>
    `${num(reach, 1)} kombinacija dolazi do ove odluke · EV raspona ${signedBb(value)}`,
  solvedTo: (exploitability: number, iterations: number) =>
    `Solvano do ${num(exploitability, 2)} % pota exploitabilityja u ${num(iterations)} iteracija.`,
  rangeNote: "Ćelija blijedi što manje te ruke dolazi do odluke. Karte su u bojama samog solvea.",
};
