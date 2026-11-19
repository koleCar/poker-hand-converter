import type { Dict } from "../types";

/** Free i Pro: stranica s cijenama, potvrda prije plaćanja i Free oznake. Same shape as `pricing.en.ts`. */
export const pricingHr: Dict["pricing"] = {
  metaTitle: "Cijene — Free i Pro | Rail",
  metaDescription:
    "Rail je besplatan: učitavanje, konverzija, replay i dijeljenje ruku, osnovna statistika i preflop chartovi solvera. Pro dodaje potpune izvještaje, analizu, HUD i neograničene flopove.",

  periods: { month: "Mjesečno", half_year: "6 mjeseci", year: "Godišnje" },
  periodLabel: "Razdoblje naplate",
  youAreOn: (plan) => `Tvoj plan: ${plan}.`,
  free: "Free",
  pro: "Pro",
  zero: "0 $",
  forever: "zauvijek",
  perMonth: " / mjesec",
  bill: {
    month: "Naplata mjesečno",
    half_year: (price) => `${price} svakih 6 mjeseci`,
    year: (price) => `${price} jednom godišnje`,
  },
  currentPlan: "Trenutni plan",
  upgrade: "Prijeđi na Pro",
  soon: "Plaćeni planovi uskoro",
  manage: "Upravljaj pretplatom",
  plansLabel: "Planovi",
  included: "Uključeno",
  notIncluded: "Nije uključeno",

  groups: { hands: "Ruke", statistics: "Statistika", desktop: "Desktop aplikacija", study: "Učenje" },
  rows: {
    upload: { label: "Učitavanje, konverzija i replay", note: "Sve podržane sobe, i ručni unos" },
    perDay: { label: "Spremljenih ruku dnevno", note: "Web učitavanje i desktop sinkronizacija zajedno" },
    library: { label: "Biblioteka ruku" },
    deleteHands: { label: "Brisanje ruku", note: "Jedne, odabranih ili svih" },
    share: { label: "Dijeljenje ruku, forum, ankete" },
    graph: { label: "Graf rezultata i osnovna statistika" },
    reports: { label: "Potpuni izvještaji", note: "Situacije, sesije, protivnici" },
    players: { label: "Igrači", note: "Profili svih s kojima si igrao" },
    desktopImport: { label: "Uvoz i ruke na tvom računalu" },
    sync: { label: "Sinkronizacija s webom" },
    tiling: { label: "Raspored stolova i RNG" },
    hud: { label: "HUD" },
    solver: { label: "Solver", note: "Svaki turn i river na flopovima koje otvoriš; preflop chartovi uvijek otvoreni" },
    nodelock: { label: "Nodelock", note: "Zaključaj strategiju i riješi ponovno" },
    analysis: { label: "Analiza", note: "Propusti, pregled sesije, plan, napredak, tvoji chartovi" },
    trainer: { label: "Trener", note: "Vježbe iz tvojih situacija" },
    review: { label: "Red za pregled", note: "Ruke koje označiš rješavaju se prve" },
  },
  cells: {
    hands: (count) => count,
    library: (count) => `${count} ruku`,
    flops: (count) => `${count} flopa dnevno`,
    unlimited: "Neograničeno",
  },
  foot: {
    cancel: "Otkaži kad god želiš",
    keep: "Ruke ostaju ako se vratiš na Free",
    tax: "Cijene u USD, porez pri plaćanju",
  },

  signInReason: (period, price) => `Prijavi se za Pro · ${period} · ${price}`,

  confirm: {
    title: "Rail Pro",
    today: "Danas",
    then: {
      month: (price) => `Zatim ${price} svaki mjesec dok ne otkažeš.`,
      half_year: (price) => `Zatim ${price} svakih 6 mjeseci dok ne otkažeš.`,
      year: (price) => `Zatim ${price} svake godine dok ne otkažeš.`,
    },
    tax: "Porez prema adresi za naplatu dodaje se na sljedećoj stranici.",
    pay: "Nastavi na plaćanje",
    cancel: "Ne sada",
  },

  success: {
    waiting: "Uključujem Pro…",
    waitingNote: "Obično nekoliko sekundi.",
    slow: "Traje duže nego inače. Plan će se sam ažurirati; ovu stranicu možeš napustiti.",
    done: "Sada si na Pro planu",
    openAnalysis: "Otvori analizu",
    getApp: "Preuzmi desktop aplikaciju",
    receipt: "Račun je poslan na tvoj email.",
  },
  cancel: {
    heading: "Ništa nije plaćeno",
    back: "Natrag na cijene",
  },

  bar: { upgrade: "Nadogradi", pricing: "Cijene" },
  lock: {
    see: "Pogledaj Pro",
    line: {
      analysis: "Pronađi svoje propuste iz vlastitih ruku",
      reports_full: "Svaka situacija, sesija i protivnik iz tvojih ruku",
      learn: "Learn je dio Pro plana",
      desktop_sync: "Sinkroniziraj desktop aplikaciju s webom",
      hud: "Statistika na tvojim stolovima dok igraš",
      solver_unlimited: "Svaki flop, svaki dan",
      nodelock: "Zaključaj strategiju i riješi ponovno",
    },
    tip: (what) => `${what} je dio Pro plana.`,
  },
  solver: {
    today: "Današnji flopovi",
    count: (used, cap) => `${used} / ${cap}`,
    left: (n) => `još ${n}`,
    open: (flop) => `Otvori ${flop}`,
    otherLine: "Nije riješen na ovoj liniji",
    refused: (cap, time) =>
      `Otvorio si današnja ${cap} flopa. Ostaju otvoreni, sa svakim turnom i riverom, do ${time}. Svaki flop uz Pro.`,
    signIn: (cap) => `Prijavi se da otvaraš flopove. Besplatan račun otvara ${cap} dnevno.`,
    signInButton: "Prijava",
    signInReason: "Prijavi se da otvaraš flopove",
    nodelock: "Nodelock",
  },
};
