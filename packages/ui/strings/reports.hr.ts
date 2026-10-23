/**
 * The Reports screen's words, Croatian. Same shape as `reports.en.ts`; moved
 * from the desktop app's dictionary (`app/src/i18n/hr.ts` `reports`, R4.5c).
 */

import type { reportsUiEn } from "./reports.en";
import { plural } from "./plural";

const num = (value: number) => value.toLocaleString("hr-HR");
/** Nominativ: 1 ruka, 2 ruke, 5 ruku. */
const ruku = (count: number) => `${num(count)} ${plural(count, "ruka", "ruke", "ruku")}`;

export const reportsUiHr: typeof reportsUiEn = {
  loading: "Zbrajam tvoje ruke…",
  storeError: (reason) => `Izvještaj se nije učitao: ${reason}`,
  noMatch: "Nijedna tvoja ruka ne odgovara ovim filterima.",
  count: (count) => ruku(count),
  defaultFormat: (format) =>
    `Prikazujem samo: ${format}. Turnirski žetoni i cash ne zbrajaju se u jedan rezultat. Promijeni to čipom Igra.`,
  summary: {
    label: "Sažetak",
    hands: "Ruke",
    result: "Rezultat",
    netBb: "Big blindovi",
    bb100: "bb/100",
    evBb100: "All-in EV bb/100",
  },
  units: {
    mixedKind:
      "Ove ruke miješaju turnirske žetone i cash, pa nema rezultata za zbrojiti ni grafa za nacrtati. Filtriraj na jedan format igre.",
    mixedCurrency:
      "Ove ruke obuhvaćaju više valuta, pa su iznosi u novcu izostavljeni; big blindovi se zbrajaju ispravno.",
  },
  evPending: (count) =>
    `Za ${num(count)} all-in ${plural(count, "ruku", "ruke", "ruku")} equity se još računa u pozadini; dotad ${plural(count, "je", "ih", "ih")} EV linija broji po rezultatu.`,
  graph: {
    heading: "Zarada",
    unit: "Prikaži u",
    bigBlinds: "Big blindovi",
    money: "Novac",
  },
  stats: {
    heading: "Statistika",
    groups: {
      preflop: "Preflop",
      postflop: "Postflop",
      showdown: "Showdown",
      results: "Rezultati",
    },
    note: "Vrijednost blijedi dok je uzorak malen; zadrži pokazivač na njoj za uzorak i 95 % interval.",
    yours: (name) => `${name} (vlastita)`,
  },
  breakdown: {
    heading: "Raščlamba",
    splitBy: "Podijeli po",
    computing: "Brojim…",
    handClassHidden:
      "Početne ruke su skrivene dok je otvoren poker stol: Rail tijekom igre ne prikazuje tablice ruku. Vraćaju se kad se stolovi zatvore.",
    tabs: {
      position: "Pozicija",
      stake: "Ulozi",
      size: "Veličina stola",
      site: "Soba",
      format: "Igra",
      potType: "Tip pota",
      stack: "Dubina stacka",
      players: "Broj igrača",
      street: "Dosegnuta ulica",
      handClass: "Početne ruke",
    },
    heads: {
      position: "Pozicija",
      stake: "Ulozi",
      size: "Stol",
      site: "Soba",
      format: "Igra",
      potType: "Pot",
      stack: "Stack",
      players: "Igrači",
      street: "Ulica",
      handClass: "Ruka",
    },
    unknown: "Nepoznato",
    noPosition: "Bez pozicije",
    headsUp: "Heads-up",
    handed: (players) => `${players} za stolom`,
    stacks: {
      "0-20": "Ispod 20 bb",
      "20-40": "20–40 bb",
      "40-70": "40–70 bb",
      "70-100": "70–100 bb",
      "100-150": "100–150 bb",
      "150-250": "150–250 bb",
      "250+": "250 bb i više",
    },
    streets: {
      preflop: "Preflop",
      flop: "Flop",
      turn: "Turn",
      river: "River",
      showdown: "Showdown",
    },
    empty: "U ovoj podjeli nema ruku.",
  },
  matrix: {
    colourBy: "Boja prema",
    metrics: {
      bb_per_100: "Winrate",
      vpip: "VPIP",
      pfr: "PFR",
      hands: "Podijeljeno",
    },
    gridLabel: "Početne ruke, trinaest puta trinaest",
    cellLabel: (handClass, count) => `${handClass}: ${count === null ? "nikad podijeljena" : ruku(count)}`,
    neverDealt: "nikad podijeljena u ovom uzorku",
    notHoldem: "Mreža je za početne ruke Hold'ema; ove ruke ih nemaju. Tablica navodi svaku klasu.",
    selected: (handClass) => `${handClass} u ovom uzorku`,
  },
};
