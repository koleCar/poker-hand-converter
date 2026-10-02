/**
 * Strings for sharing a hand's analysis (A7.1), Croatian. Same shape as
 * `analysisShare.en.ts`. Poker words stay the ones Croatian players use; the
 * sentences around them are Croatian, addressed with "ti".
 */

export const shareHr = {
  toggle: {
    label: "Podijeli analizu ove ruke",
    explain:
      "Zadano isključeno. Kad je uključeno, svatko tko na Railu može vidjeti ovu ruku vidi i njezine ocjene, opcije reference i objašnjenja: na njezinoj objavljenoj stranici, u temi na forumu, u anketi „Što bi ti napravio?” nakon što odgovori te preko linkova za dijeljenje koje si napravio/la. Samo ova ruka: ostale ruke, statistika i izvještaji ostaju privatni.",
    pollNote: "U anketi čitatelji vide odgovor reference tek nakon što glasaju.",
    notAnalysed:
      "Ova ruka nema spremljenu analizu u trenutačnoj verziji, pa se još nema što prikazati. Pokreni analizu na kartici Analiza.",
    saving: "Spremam…",
    shared: "Podijeljeno: analiza se prikazuje svugdje gdje je ova ruka javna.",
    private: "Privatno: ovu analizu vidiš samo ti.",
    failed: (message: string) => `Spremanje nije uspjelo: ${message}`,
  },

  sheet: {
    note: "Podijelio/la ju je igrač koji je objavio ovu ruku. Objašnjenja mu se obraćaju s „ti”.",
    heroMove: "Potez heroja",
    decisionsHeading: "Odluke heroja",
    noDecisions: "Hero u ovoj ruci nije donio nijednu odluku.",
    heroHand: "Ruka heroja",
    stale: (version: string) =>
      `Analizirano starijom verzijom (${version}); igrač je još nije ažurirao, pa novijih ocjena (poput onih na turnu) nema.`,
  },

  poll: {
    heading: "Odgovor reference",
    intro: "Kako referenca igra ovu situaciju s rukom heroja, uz to kako su čitatelji odgovorili.",
    heroGraded: "Potez heroja:",
    reference: (freq: string, ev: string) => `Referenca ${freq} · EV ${ev}`,
    bestSize: (label: string) => `najbolje: ${label}`,
    notInReference: "Referenca ovdje nema tu opciju",
    notGraded: "Odluka iz ankete nije ocijenjena, pa nema odgovora reference.",
    authorHint: "Podijeli analizu ove ruke da bi se ovdje prikazao odgovor reference čitateljima koji su odgovorili.",
  },
};
