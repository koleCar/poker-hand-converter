import { shownPercent } from "../../format";
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
  const shown = shownPercent(value);
  return `${shown.bound ?? ""}${num(shown.value, shown.digits)} %`;
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
const size = (value: number) => {
  const tenth = Math.round(value * 10) / 10;
  return num(tenth, tenth % 1 !== 0 ? 1 : 0);
};
/** 1 kombinacija, 2 kombinacije, 5 kombinacija. */
const combos = (count: number) => `${num(count)} ${plural(count, "kombinacija", "kombinacije", "kombinacija")}`;
const tableName = (players: number) => (players === 2 ? "Heads-up" : players === 9 ? "9-max" : "6-max");

export const solverHr: Dict["solver"] = {
  heading: "Solver library",
  intro: "Railovi vlastiti solvovi: složi preflop liniju igrača po igrača, odaberi flop i prođi kroz odluke na flopu.",
  unavailable: "Solver library nije postavljen na ovom serveru.",
  loading: "Učitavanje…",
  loadError: "Ovaj solve se nije mogao učitati. Pokušaj ponovno za trenutak.",
  retry: "Pokušaj ponovno",

  settings: {
    title: "Stol",
    change: "Promijeni",
    players: "Igrači",
    depth: "Dubina stacka",
    done: "Gotovo",
    cash: "Cash",
    summary: (players: number, stackBb: number) => `${tableName(players)} · ${num(stackBb)} bb`,
    playersName: tableName,
    depthName: (stackBb: number) => `${num(stackBb)} bb`,
  },

  preflop: {
    label: "Preflop linija",
    stack: size,
    action: (action: string, toBb: number) =>
      action === "raise"
        ? `Raise ${size(toBb)}`
        : (({ fold: "Fold", check: "Check", call: "Call", allin: "All-in" }) as Record<string, string>)[action] ?? action,
    rewind: (position: string) => `Natrag na odluku: ${position}`,
    foldTo: (position: string) => `Svi prije pozicije ${position} foldaju`,
    toAct: "na potezu",
    folded: (winner: string) => `Svi foldaju do ${winner}: flopa nema.`,
    multiway: (players: string) => `Multiway flop (${players}): knjižnica solva samo heads-up flopove.`,
    allin: "All-in prije flopa: nema flopa za solvati.",
    notSolved: (oop: string, ip: string) => `${ip} protiv ${oop}: ova linija još nije u solver libraryju.`,
    setEmpty: "Flop solvovi za ovaj stol još nisu objavljeni.",
  },

  flop: {
    pick: "Odaberi flop",
    change: "Promijeni flop",
    title: "Odaberi flop",
    clear: "Očisti",
    random: "Nasumični solvani flop",
    missing: "Odabrani flop ne postoji.",
    hint: "Odaberi tri karte.",
    slot: "Prazno",
    solved: (count: number) =>
      `${num(count)} ${plural(count, "solvani flop", "solvana flopa", "solvanih flopova")} na ovoj liniji`,
    card: (card: string, picked: boolean) => `${card}${picked ? ", odabrana" : ""}`,
  },

  panel: {
    overview: "Pregled",
    actions: "Akcije",
    hand: "Ruka",
    board: "Board",
    pot: (pot: number, toCall: number) => (toCall > 0 ? `Pot ${bb(pot)} · ${bb(toCall)} za call` : `Pot ${bb(pot)}`),
    toAct: (position: string) => `Na potezu: ${position}`,
    history: "Odluke na flopu",
    start: "Flop",
    step: (position: string, action: string) => `${position} ${action}`,
    follow: (label: string) => `Odigraj ${label}`,
    ends: {
      fold: "Ruka je gotova.",
      street: "Dijeli se turn: knjižnica čuva samo odluke na flopu.",
    },
  },

  action: (kind: string, sizePot: number, amount: number) =>
    kind === "bet"
      ? `Bet ${pct(sizePot)}`
      : kind === "raise"
        ? `Raise ${size(amount)}`
        : (({ fold: "Fold", check: "Check", call: "Call", allin: "All-in" }) as Record<string, string>)[kind] ?? kind,
  share: (share: number, count: number) => `${pct1(share)} · ${combos(Math.round(count))}`,
  shareOnly: pct1,
  combosCount: (count: number) => combos(Math.round(count)),
  gridLabel: (position: string) => `${position}: strategija za svih 169 ruku`,
  cellLabel: (hand: string, parts: string[], absent: boolean) => `${hand}: ${absent ? "nije u rasponu" : parts.join(", ")}`,
  part: (label: string, freq: number) => `${label} ${pct1(freq)}`,
  detailEmpty: "Pređi mišem ili odaberi ruku da vidiš koliko vrijedi koja akcija.",
  reaches: (reach: number, count: number) => `${num(reach, 1)} od ${combos(count)} dolazi do ove odluke.`,
  reachesShare: (share: number) => `Do ove odluke dolazi s ${pct1(share)} svojih kombinacija.`,
  absent: "Ovdje nije u rasponu.",
  combo: "Kombinacija",
  weight: "Težina",
  ev: "EV",
  value: (value: number) => `EV ${signedBb(value)}`,
  freq: pct1,
  signedBb,
  evShort: (value: number) => num(Math.round(value * 100) / 100 || 0, 2),
  rangeValue: (reach: number, value: number) =>
    `${num(reach, 1)} kombinacija dolazi do ove odluke · EV raspona ${signedBb(value)}`,
  solvedTo: (exploitability: number, iterations: number) =>
    `Solvano do ${num(exploitability, 2)} % pota exploitabilityja u ${num(iterations)} iteracija.`,
  chartNote: "Preflop: Railovi vlastiti chartovi. Ćelija blijedi što manje te ruke dolazi do odluke.",
  flopNote: "Ćelija blijedi što manje te ruke dolazi do odluke. Kombinacije su u bojama odabranog flopa.",
};
