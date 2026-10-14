/**
 * The statistics words both surfaces show, Croatian. Same shape as
 * `stats.en.ts`, and data like it: the web's `lib/i18n/ns/stats.hr.ts` takes
 * these blocks from here (R2.7b) and the desktop app hands them to
 * `UiStringsProvider`.
 */

import { plural } from "./plural";

const num = (value: number) => value.toLocaleString("hr-HR");
/** Nominativ: 1 ruka, 2 ruke, 5 ruku. */
const hands = (count: number) => `${num(count)} ${plural(count, "ruka", "ruke", "ruku")}`;
/** Akuzativ, iza "kroz": kroz 1 ruku, kroz 2 ruke, kroz 5 ruku. */
const handsAcc = (count: number) => `${num(count)} ${plural(count, "ruku", "ruke", "ruku")}`;

export const statsUiHr = {
  hands,
  handsHead: "Ruke",
  bb: (amount: string) => `${amount} bb`,
  sampleOnly: (n: string) => `n = ${n}`,

  tile: {
    reliability: {
      ok: "Dovoljan uzorak — ovaj broj je stabilan.",
      low: "Srednji uzorak — oblik je stvaran, decimala nije.",
      insufficient: "Mali uzorak — čitaj ovo kao naznaku, ne kao mjerenje.",
    },
    noOpportunities: "nema prilika",
    interval: (low: string, high: string) => `95% interval pouzdanosti, od ${low}% do ${high}%`,
    sample: (n: string, low: string, high: string) => `n = ${n}, 95% interval pouzdanosti ${low}–${high}%`,
    noSample: "nema uzorka",
  },

  table: {
    statistic: "Statistika",
    value: "Vrijednost",
    sample: "Uzorak",
  },

  graph: {
    series: {
      total: { label: "Ukupno", hint: "Sve dobiveno i izgubljeno" },
      showdown: { label: "Showdown", hint: "Ruke koje su došle do showdowna" },
      nonShowdown: { label: "Bez showdowna", hint: "Ruke završene prije showdowna" },
      allInEv: {
        label: "All-in EV",
        hint: (runouts: number) => `Ukupno, s all-in runoutima (${num(runouts)}) isplaćenima po equityju`,
      },
    },
    mixedUnitKind:
      "Ovaj uzorak miješa turnirske čipove i cash, pa nema grafa winratea koji bi se mogao nacrtati. Čipovi nisu novac — vrijede onoliko koliko kaže struktura isplata — a krivulja koja ih zbraja s dolarima bila bi oblik bez značenja. Filtriraj na jedan format igre.",
    notEnough:
      "Još nema dovoljno ruku za krivulju. Graf treba barem nekoliko skupina odigranih ruku; nastavi učitavati.",
    ariaLabel: (count: number) =>
      `Kumulativni winrate kroz ${handsAcc(count)}, podijeljen na ukupne big blindove te one dobivene sa showdownom i bez njega.`,
    axisLabel: "Odigrane ruke",
    noDates: "ove ruke nemaju datume",
    noAllIns: "još nema all-ina",
    notComputed: "još nije izračunato",
    noAllInsHint: "Pojavljuje se čim neka ruka u ovom uzorku ima all-in prije posljednje karte",
    notComputedHint: "Treba equity kroz runout",
    mixedCurrency:
      "Ovaj uzorak obuhvaća više valuta, pa je serija u novcu izostavljena i crtaju se samo one u big blindovima. Dolari zbrojeni s eurima daju krivulju bez jedinice; big blindovi su jedinica igre i zbrajaju se ispravno.",
    showNumbers: "Prikaži brojke",
    from: "Od",
    to: "Do",
  },
};
