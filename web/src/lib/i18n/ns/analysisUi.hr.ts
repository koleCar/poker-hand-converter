/**
 * Strings for the redesigned Analysis screens, Croatian. Same shape as
 * `analysisUi.en.ts`.
 */

import type { Dict } from "../types";

const num = (value: number, digits = 0) =>
  value.toLocaleString("hr-HR", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const uiHr: Dict["analysis"]["ui"] = {
  nav: {
    label: "Analiza",
    overview: "Pregled",
    session: "Sesije",
    leaks: "Leakovi",
    progress: "Trendovi",
    reports: "Izvještaji",
    train: "Vježbaj",
    charts: "Chartovi",
    concepts: "Pojmovi",
  },
  run: {
    behind: (count: number) => `${num(count)} novih`,
    stale: (count: number) => `${num(count)} za ažurirati`,
    analyse: "Analiziraj",
    update: "Ažuriraj",
    running: (done: number, total: number) => `Analiziram ${num(done)} / ${num(total)}`,
    stop: "Stani",
    recent: (count: number) => `Zadnjih ${num(count)}`,
    all: "Sve",
    failed: "Analiza nije uspjela",
  },
  scope: {
    position: "Pozicija",
    pot: "Pot",
    any: "Sve",
  },
  kpi: {
    outOf: "/100",
    score: "Ocjena",
    evLost: "Izgubljeni EV",
    per100: "bb/100",
    mistakes: "Greške",
    graded: "Ocijenjeni potezi",
    gradedOf: (hands: number) => `${num(hands)} ruku`,
  },
  grades: {
    label: "Ocjene",
    clear: "Očisti",
    filter: (grade: string, share: string) => `Prikaži ruke kojima je najgori potez ${grade} (${share})`,
  },
  heat: {
    title: "Gdje odlazi EV",
    rows: { position: "Pozicija", pot: "Vrsta pota" },
    metrics: { ev: "Izgubljeni EV", score: "Ocjena", mistakes: "Greške %" },
    low: "Malo",
    high: "Puno",
    hint: "Klikni polje za filtriranje ruku",
    decisions: (count: number) => `${num(count)} odl.`,
    cell: (row: string, street: string, ev: string, score: string, mistakes: string, graded: number) =>
      `${row} · ${street}: ${ev} bb/100 izgubljeno, ocjena ${score}, ${mistakes} grešaka u ${num(graded)} ocijenjenih poteza`,
    none: "Ovdje još ništa nije ocijenjeno",
  },
  hands: {
    title: "Ruke",
    count: (count: number) => `${num(count)}`,
    cols: { hand: "Ruka", pos: "Poz.", spot: "Situacija", line: "Linija", worst: "Najgore", evLost: "Izgubljeni EV", result: "Rezultat", when: "Kada" },
    more: "Više filtera",
    clear: "Očisti",
    empty: "Ovdje nema ruku",
  },
  empty: { upload: "Učitaj ruke" },
  side: {
    topLeaks: "Najveći leakovi",
    allLeaks: "Svi leakovi",
    drills: "Drillovi na redu",
    now: "sada",
    train: "Vježbaj",
    week: "Ovaj tjedan",
    tasks: (done: number, total: number) => `${done} / ${total}`,
    buildPlan: "Složi plan za ovaj tjedan",
  },
};
