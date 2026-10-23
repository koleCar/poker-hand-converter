/**
 * The session review's words, Croatian. Same shape as `review.en.ts`; the
 * grade, street, action and preflop-spot words are the web analysis's
 * (`frontend/src/lib/i18n/ns/analysis.hr.ts`).
 */

import type { reviewUiEn } from "./review.en";
import { plural } from "./plural";

const num = (value: number) => value.toLocaleString("hr-HR");
/** Nominativ: 1 ruka, 2 ruke, 5 ruku. */
const ruku = (count: number) => `${num(count)} ${plural(count, "ruka", "ruke", "ruku")}`;

export const reviewUiHr: typeof reviewUiEn = {
  title: "Pregled sesije",
  intro:
    "Ruke iz jedne sesije koje vrijedi ponovno pogledati: tvoje najlošije ocijenjene odluke, mjesta gdje si odstupio od preflop chartova i najveći potovi. Svaka se otvara u svojoj analizi.",
  loading: "Tražim tvoju sesiju…",
  error: (reason) => `Pregled sesije se nije učitao: ${reason}`,
  noHands: "Još nema sesije: kad spremiš ruke, ovdje se pregledava tvoja zadnja sesija.",
  noMatch: "Nijedna tvoja ruka ne odgovara ovom filteru, pa nema sesije za pregled.",
  hiddenDuringPlay:
    "Pregled sesije skriven je dok je otvoren poker stol: to je analiza, a analiza je za poslije igre.",

  picker: {
    label: "Sesija",
    latest: "Zadnja završena sesija",
    option: (day, from, to, count) => `${day}, ${from}–${to} · ${ruku(count)}`,
    previous: "Prethodna sesija",
    next: "Sljedeća sesija",
    gap: (minutes) =>
      `Pauza dulja od ${minutes < 60 ? `${minutes} minuta` : `${minutes / 60} ${plural(minutes / 60, "sata", "sata", "sati")}`} završava sesiju.`,
    filtered: "Sesije prema filteru iz Statistike.",
    clearFilter: "Sve ruke",
  },

  ongoing: {
    text: (from, to) =>
      `Tvoja zadnja sesija (${from}–${to}) možda još traje, pa je prikazana zadnja završena. Pregled je za poslije igre.`,
    reviewNow: "Pregledaj je sada",
  },
  notFinished: "Zadnja ruka ove sesije odigrana je prije manje od pauze, pa sesija možda još traje. Pregled je za poslije igre.",

  summary: {
    label: "Sažetak sesije",
    when: "Kada",
    hands: "Ruke",
    duration: "Trajanje",
    durationValue: (minutes) => (minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`),
    tables: "Stolovi",
    result: "Rezultat",
    netBb: "Big blindovi",
    bb100: "bb/100",
    evBb: "All-in EV, big blindovi",
    evNote: (count) => `All-in ruke brojene po EV-u: ${num(count)}`,
    mixedKind: "Ova sesija miješa turnirske žetone i cash, pa nema rezultata za zbrojiti.",
    mixedCurrency: "Ova sesija obuhvaća više valuta, pa je rezultat u novcu izostavljen; big blindovi se zbrajaju.",
  },

  coverage: {
    missing: (missing, total) =>
      `${num(missing)} od ${ruku(total)} u ovoj sesiji još ${plural(missing, "nije analizirana", "nisu analizirane", "nije analizirano")}, pa ${plural(missing, "nije", "nisu", "nisu")} u prva dva popisa.`,
    notAnalysed: (count) =>
      `${ruku(count)} ${plural(count, "je", "su", "je")} izvan onoga što analiza pokriva (multiway, druga igra, …).`,
    run: "Analiziraj svoje ruke",
  },

  lists: {
    worst: {
      heading: "Najlošije odluke",
      description: "Ocijenjene kao Netočno ili lošije, najlošije prve, zatim po EV-u koji su koštale.",
      empty: "Nijedna odluka u ovoj sesiji nije ocijenjena kao Netočno ili lošije.",
      emptyUnanalysed: "Nijedna ruka ove sesije još nije ocijenjena.",
    },
    deviations: {
      heading: "Izvan tvojih preflop chartova",
      description: "Preflop odluke koje tvoji chartovi rijetko ili nikad ne igraju (manje od 3,5 % puta), po EV-u koji su koštale.",
      empty: "Svaka ocijenjena preflop odluka ove sesije prati chartove.",
      emptyUnanalysed: "Nijedna ruka ove sesije još nije ocijenjena.",
    },
    pots: {
      heading: "Najveći potovi",
      description: "U big blindovima, s tvojim rezultatom.",
      empty: "Nijedan pot u ovoj sesiji nema veličinu u big blindovima.",
    },
    more: (count) =>
      `Još ${ruku(count)} ${plural(count, "je", "su", "je")} u popisima iznad.`,
  },

  badges: {
    worst: (rank) => `Najlošija odluka #${rank}`,
    deviations: (rank) => `Izvan charta #${rank}`,
    pots: (rank) => `Veliki pot #${rank}`,
  },

  row: {
    open: (cards, when) => `Otvori ruku ${cards} od ${when} u njezinoj analizi`,
    pot: (bb) => `Pot ${bb} bb`,
    result: (bb) => `${bb} bb`,
    ev: (bb) => `EV ${bb} bb`,
    evLoss: (bb) => `−${bb} bb EV`,
    took: (street, action) => `${street}: ${action}`,
    best: (action) => `najbolje: ${action}`,
    chartFreq: (percent) => `chart to igra ${percent} %`,
    noCards: "Karte nepoznate",
  },

  grades: {
    perfect: "Savršeno",
    good: "Dobro",
    inaccurate: "Netočno",
    mistake: "Greška",
    blunder: "Gruba greška",
  },
  streets: { preflop: "Preflop", flop: "Flop", turn: "Turn", river: "River" },
  actions: { fold: "Fold", check: "Check", call: "Call", bet: "Bet", raise: "Raise", allin: "All-in" },

  deviationSource: {
    label: "Usporedi s",
    shipped: "Railovi chartovi",
    description: (name) =>
      `Preflop odluke koje tvoj chart „${name}” igra rijetko ili nikad (manje od 3,5 % vremena), po EV-u koji im daju Railovi chartovi.`,
    empty: (name) => `Svaka preflop odluka ove sesije koju tvoj chart „${name}” pokriva prati ga.`,
    freq: (percent) => `tvoj chart to igra ${percent} %`,
    best: (action) => `tvoj chart: ${action}`,
  },
  preflopSpots: {
    unopened: "Neotvoreni pot",
    "vs-limp": "Protiv limpera",
    "bb-option": "Opcija big blinda",
    "vs-open": "Protiv otvaranja",
    squeeze: "Squeeze situacija",
    "vs-3bet": "Protiv 3-beta nakon otvaranja",
    "vs-3bet-cold": "Protiv 3-beta, hladno",
    "vs-4bet": "Protiv 4-beta ili više",
  },
};
