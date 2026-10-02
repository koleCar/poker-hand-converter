import { plural } from "../plural";

/**
 * Strings for the trainer (phase A7), Croatian. Same shape as
 * `analysisTrain.en.ts`. Poker words stay the ones Croatian players use
 * (fold, call, raise, bet, check, 3-bet, open, all-in, pot); the sentences
 * around them are Croatian, addressed with "ti". Seats stay UTG, HJ, CO, BTN,
 * SB, BB.
 */

const num = (value: number, digits = 0) =>
  value.toLocaleString("hr-HR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const bb = (value: number) => `${num(value, Math.abs(value) < 10 ? 2 : 1)} bb`;
const pct = (value: number) => {
  const p = value * 100;
  return p > 0 && p < 10 ? `${num(Math.round(p * 10) / 10, 1)} %` : `${num(Math.round(p))} %`;
};
const drills = (count: number) => `${num(count)} ${plural(count, "vježba", "vježbe", "vježbi")}`;
const days = (count: number) => `${num(count)} ${plural(count, "dan", "dana", "dana")}`;

const potNames: Record<string, string> = {
  srp: "Pot s jednim raiseom",
  "3bp": "3-bet pot",
  limped: "Limpani pot",
};

export const trainHr = {
  heading: "Vježbaj",
  intro:
    "Vježbaj protiv iste reference po kojoj se ocjenjuju tvoje ruke: preflop charta, river solveova i tvojih vlastitih grešaka, dok ne budu točne. Svaki odgovor ocijenjen je točno onako kako bi ga ocijenila analiza.",
  modesLabel: "Što vježbaš",
  modes: { preflop: "Preflop", river: "River", drills: "Tvoje greške" } as Record<string, string>,

  settings: {
    label: "Postavke trenera",
    family: "Situacija",
    families: {
      random: "Bilo koja situacija",
      rfi: "Prvi ulaziš (RFI)",
      "vs-open": "Protiv opena",
      "vs-3bet": "Protiv 3-beta",
      squeeze: "Squeeze",
      bvb: "Blind protiv blinda",
      "vs-4bet": "Protiv 4-beta",
    } as Record<string, string>,
    seat: "Tvoja pozicija",
    anySeat: "Bilo koja",
    deal: "Ruke",
    deals: { range: "Kako ih range drži", borderline: "Uglavnom tijesne odluke" } as Record<string, string>,
    table: "Stol",
    tableValue: (players: number, stack: number) => `${players}-max · ${num(stack)} bb · cash`,
    pot: "Pot",
    pots: { any: "Bilo koji pot", ...potNames } as Record<string, string>,
    side: "Tvoja pozicija",
    sides: { any: "Svejedno", ip: "U poziciji", oop: "Bez pozicije" } as Record<string, string>,
  },

  dealing: "Dijelim…",
  solving: "Rješavam river…",
  grading: "Ocjenjujem…",
  failed: (message: string) => `Trener nije uspio podijeliti situaciju: ${message}`,
  noSpot: "Nijedna situacija ne odgovara ovim postavkama. Probaj drugu poziciju ili situaciju.",
  retry: "Pokušaj ponovno",

  spotHeading: "Situacija",
  yourHand: "Tvoja ruka",
  question: "Što radiš?",
  preflopSpot: (spot: string) => `${spot}.`,
  riverSpot: (pot: string, hero: string, villain: string, inPosition: boolean) =>
    `${potNames[pot] ?? pot}, ${hero} protiv ${villain}. ${inPosition ? "U poziciji si" : "Bez pozicije si"}.`,
  riverFacing: (villain: string, kind: string, toBb: number, sizePot: number) =>
    kind === "allin" ? `${villain} ide all-in za ${bb(toBb)}.` : `${villain} beta ${bb(toBb)} (${pct(sizePot)} pota).`,
  riverChecked: (villain: string) => `${villain} checka prema tebi.`,
  riverFirst: "Na riveru si prvi na potezu.",
  potLine: (pot: number, toCall: number, behind: number) =>
    toCall > 0 ? `Pot ${bb(pot)} · ${bb(toCall)} za call · ${bb(behind)} efektivno` : `Pot ${bb(pot)} · ${bb(behind)} efektivno`,
  rangesNote:
    "Rangeovi: preflop rangeovi iz charta, suženi na flopu i turnu heurističkim modelom — aproksimacija, ista na kojoj počivaju tvoje river ocjene.",
  placeholderNote: "Jedan od preflop rangeova je označeni zamjenski range: charti nemaju čvor za tu liniju.",

  answersLabel: "Tvoje opcije",
  keyHint: (key: string) => `tipka ${key}`,

  result: {
    heading: "Kako je prošlo",
    youChose: (label: string) => `Odabrao si: ${label}`,
    evLost: (loss: number, pot: number) => `Izgubljeni EV ${bb(loss)} (${pct(pot)} pota)`,
    noLoss: "Bez izgubljenog EV-a",
    best: (label: string) => `Najbolje: ${label}`,
    next: "Sljedeća situacija",
    optionsHeading: "Sve opcije, za tvoju ruku",
    chartHeading: "Cijeli chart",
    rangeHeading: "Cijeli range u ovom čvoru",
    whyHeading: "Zašto",
    approximate: "Aproksimacije",
    notGraded: (reason: string) => `Ovaj odgovor nije moguće ocijeniti: ${reason}`,
    saved: "Spremljeno u tvoju povijest treninga.",
    signInToKeep: "Prijavi se da bi spremao rezultate i vježbao vlastite greške.",
  },

  session: {
    heading: "Ova sesija",
    answers: (count: number) => `${num(count)} ${plural(count, "odgovor", "odgovora", "odgovora")}`,
    score: "Score",
    accuracy: "Odigrano kao referenca",
    streak: "Niz",
    best: "Najbolji niz",
    evLost: "Izgubljeni EV",
    bb,
    pct,
    none: "Još nema odgovora.",
    reset: "Kreni ispočetka",
    distribution: "Odgovori po klasi",
  },

  history: {
    heading: (count: number) => `Tvoj trening, zadnjih ${days(count)}`,
    row: (answers: number, score: number | null, evLoss: number) =>
      `${num(answers)} ${plural(answers, "odgovor", "odgovora", "odgovora")}${score === null ? "" : ` · score ${num(score, 1)}`} · izgubljeno ${bb(evLoss)}`,
    none: "Još nema spremljenih odgovora.",
    modes: { preflop: "Preflop", river: "River", drill: "Tvoje greške" } as Record<string, string>,
  },

  drills: {
    heading: "Tvoje greške, dok ne budu točne",
    intro:
      "Svaka tvoja odluka ocijenjena kao Greška ili Gruba greška vraća se ovdje kao „što bi ti napravio?”. Pogrešan odgovor vraća se za deset minuta, točan nakon jednog dana, pa šest dana, pa svaki put sve kasnije.",
    syncing: "Skupljam tvoje greške…",
    loading: "Učitavam ruku…",
    counts: {
      due: "Na redu sada",
      dueToday: "Na redu danas",
      items: "Vježbe",
      learning: "Ponovno učiš",
      mature: "Naučeno (3+ tjedna)",
    },
    includeInaccurate: "Uključi i netočne poteze",
    practiseAll: "Vježbaj sve, ne samo ono na redu",
    leak: (spots: number) => `Vježbaš jedan leak (${num(spots)} ${plural(spots, "situacija", "situacije", "situacija")}).`,
    allDrills: "Sve vježbe",
    empty: "Trenutno ništa nije na redu. Vrati se kasnije ili vježbaj sve.",
    emptyLeak: "Za ovaj leak nema vježbi: nijedna njegova odluka nije ocijenjena kao Greška ili gore.",
    noneYet: "Još nema vježbi: analiziraj svoje ruke i tvoje Greške i Grube greške pojavit će se ovdje.",
    goToAnalysis: "Idi na analizu",
    fromHand: (date: string) => `Iz tvoje ruke od ${date}`,
    fromHandUndated: "Iz jedne od tvojih ruku",
    youPlayed: (label: string, grade: string) => `Kad si je igrao: ${label} — ${grade}.`,
    backIn: (count: number) => `Vraća se za ${days(count)}.`,
    backSoon: "Zasad pogrešno: vraća se za deset minuta.",
    reviews: (count: number) =>
      count === 0 ? "Prvi put" : `Odgovoreno već ${num(count)} ${plural(count, "put", "puta", "puta")}`,
    handGone: "Ova ruka više nije u tvojoj biblioteci.",
    notAnalysed: "Ova odluka nema analizu na trenutnoj verziji. Pokreni analizu pa je vježbaj.",
    openHand: "Otvori ruku",
    skip: "Preskoči",
    done: (count: number) => `Gotovo: ${drills(count)} odgovoreno.`,
    notInstalledHeading: "Vježbe nisu postavljene na ovoj bazi",
    notInstalledBefore: "Primijeni ",
    notInstalledAfter: " da bi se vježbe i rezultati trenera spremali.",
  },

  keys: {
    button: "Tipke",
    title: "Tipke trenera",
    note: "Rade bilo gdje na stranici osim unutar replayera i polja obrasca; replayer ima svoje tipke (pritisni ? na njemu).",
    items: {
      options: "Odaberi opciju s tim brojem",
      fold: "Fold",
      check: "Check",
      call: "Call",
      allin: "All-in",
      next: "Sljedeća situacija (nakon odgovora)",
      help: "Ovaj popis",
    },
  },

  overview: {
    heading: "Vježbe",
    due: (due: number, today: number) =>
      due > 0
        ? `${drills(due)} na redu sada${today > due ? `, ${num(today)} danas` : ""}.`
        : today > 0
          ? `${drills(today)} na redu kasnije danas.`
          : "Danas ništa nije na redu.",
    candidates: (count: number) => `${num(count)} ${plural(count, "nova greška", "nove greške", "novih grešaka")} za vježbu.`,
    train: "Vježbaj",
  },

  leak: {
    drill: "Vježbaj ovo",
    due: (due: number, items: number) =>
      items === 0 ? "Ovdje nema grešaka za vježbu." : `${num(due)} od ${drills(items)} na redu danas.`,
    badge: (due: number) => `${num(due)} na redu`,
  },
};
