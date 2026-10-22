/**
 * The Hands screen's words, Croatian. Same shape as `hands.en.ts`; moved from
 * the desktop app's dictionary (`app/src/i18n/hr.ts` `hands`) with the
 * web library's searches and order (R4.5b).
 */

import type { handsUiEn } from "./hands.en";
import { plural } from "./plural";

const num = (value: number) => value.toLocaleString("hr-HR");
/** Nominativ: 1 ruka, 2 ruke, 5 ruku. */
const ruku = (count: number) => `${num(count)} ${plural(count, "ruka", "ruke", "ruku")}`;
/** Iza "od": od 1 ruke, od 2 ruke, od 5 ruku. */
const odRuku = (count: number) => `${num(count)} ${plural(count, "ruke", "ruke", "ruku")}`;

export const handsUiHr: typeof handsUiEn = {
  storeError: (reason) => `Popis ruku nije se učitao: ${reason}`,
  loading: "Učitavam ruke…",
  noMatch: "Nijedna ruka ne odgovara ovim filterima.",
  count: (shown) => ruku(shown),
  countOf: (matching, total) => `${num(matching)} od ${odRuku(total)}`,
  loadingMore: "Učitavam još…",
  listLabel: (order) => `Ruke, ${order.toLowerCase()}`,
  columns: {
    date: "Datum",
    room: "Soba",
    stakes: "Ulozi",
    position: "Poz.",
    cards: "Karte",
    board: "Board",
    result: "Rezultat",
    bigBlinds: "bb",
    marks: "Oznake",
  },
  noCards: "—",
  preflop: "Bez flopa",
  noHero: "—",
  handId: (id) => `#${id}`,
  rowLabel: (date, room, stakes, result) => `${date}, ${room}, ${stakes}, ${result}`,
  allIn: "All-in",
  allInEv: (ev) => `All-in · EV ${ev} bb`,
  evShort: (ev) => `EV ${ev}`,
  allInPending: "All-in · EV se računa",
  showdown: "Showdown",
  hasNote: "Ima bilješku",
  positionalNames: "Anon",
  positionalNamesTitle:
    "Ova soba skriva imena igrača iza oznaka mjesta koje se mijenjaju svake ruke, pa se ruka ne može naći po imenu igrača.",
  filters: {
    label: "Filteri",
    clearAll: "Očisti sve",
    clear: "Bilo koja",
    groupLabel: (group) => `Filter: ${group}`,
    summary: (group, values) => `${group}: ${values}`,
    more: (first, more) => `${first} +${more}`,
    groups: {
      date: "Datum",
      site: "Soba",
      format: "Igra",
      variant: "Varijanta",
      limit: "Limit",
      size: "Stol",
      stakes: "Ulozi",
      position: "Pozicija",
      potType: "Pot",
      result: "Rezultat",
      stack: "Stack",
      allIn: "All-in",
      notes: "Bilješke",
      tags: "Oznake",
      player: "Igrač",
      search: "Pretraga",
      showdown: "Showdown",
      sort: "Redoslijed",
    },
    dates: {
      today: "Danas",
      week: "Zadnjih 7 dana",
      month: "Zadnjih 30 dana",
      year: "Zadnjih 12 mjeseci",
      custom: "Raspon",
      from: "Od",
      to: "Do",
    },
    formats: {
      cash: "Cash",
      tournament: "Turnir",
      sng: "Sit & Go",
      spin: "Spin",
    },
    limits: {
      nl: "No limit",
      pl: "Pot limit",
      fl: "Fixed limit",
    },
    sizes: {
      hu: "Heads-up",
      "6max": "6-max",
      full: "Full ring",
    },
    potTypes: {
      walk: "Walk",
      bomb: "Bomb pot",
      limped: "Limpani",
      "single-raised": "Jedan raise",
      "3bet": "3-bet",
      "4bet+": "4-bet+",
    },
    results: {
      won: "Dobitak",
      lost: "Gubitak",
      even: "Na nuli",
    },
    stacks: {
      "0-40": "Ispod 40 bb",
      "40-80": "40–80 bb",
      "80-120": "80–120 bb",
      "120+": "120 bb i više",
    },
    allIn: {
      yes: "All-in",
      no: "Bez all-ina",
    },
    notes: {
      yes: "S bilješkom",
      no: "Bez bilješke",
    },
    showdownValues: {
      yes: "Do showdowna",
      no: "Bez showdowna",
    },
    sorts: {
      newest: "Najnovije prve",
      oldest: "Najstarije prve",
      pot: "Najveći potovi prvi",
      won: "Najveći dobici prvi",
      lost: "Najveći gubici prvi",
    },
    search: {
      heroCards: "Heroeve karte",
      heroCardsHint: "Karte (AhKh) ili klasa ruke (AKs, TT, AK).",
      board: "Board",
      boardHint: "Karte koje su sve na boardu (Kd 7c).",
      player: "Igrač za stolom",
      playerHint: "Točan nadimak. Sobe koje skrivaju imena nikad ne odgovaraju.",
      apply: "Traži",
      cleared: "Očisti pretragu",
    },
    chips: "Žetoni",
    removePlayer: (name) => `Igrač: ${name}. Ukloni ovaj filtar`,
    noTags: "Još nema oznaka. Označi ruku u panelu uz replayer.",
    count: (value) => value,
  },
  saved: {
    button: "Spremljeni filteri",
    title: "Spremljeni filteri",
    none: "Još nema spremljenih filtera.",
    apply: (name) => `Primijeni „${name}”`,
    remove: (name) => `Obriši „${name}”`,
    name: "Naziv",
    namePlaceholder: "npr. BTN 3-bet potovi",
    save: "Spremi trenutne filtere",
    saveFailed: (reason) => `Filter nije spremljen: ${reason}`,
  },
};
