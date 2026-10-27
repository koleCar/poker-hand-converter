import { plural } from "../plural";

/**
 * Strings for the study plan (phase A8b), Croatian. Same shape as
 * `analysisPlan.en.ts`. Poker words stay the ones Croatian players use
 * (leak, raise, call, 3-bet, river, drill as "vježba"); the sentences around
 * them are Croatian, addressed with "ti". Seats stay UTG, HJ, CO, BTN, SB, BB.
 */

const num = (value: number, digits = 0) =>
  value.toLocaleString("hr-HR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const bb = (value: number) => `${num(value, Math.abs(value) < 10 ? 2 : 1)} bb`;
const moves = (n: number) => `${num(n)} ${plural(n, "ocijenjeni potez", "ocijenjena poteza", "ocijenjenih poteza")}`;
/** Lokativ iza "u": u 1 odluci, u 2 odluke, u 5 odluka. */
const decisionsLoc = (n: number) => `${num(n)} ${plural(n, "svojoj odluci", "svoje odluke", "svojih odluka")}`;
const mistakes = (n: number) => `${num(n)} ${plural(n, "greška", "greške", "grešaka")}`;
const tasks = (n: number) => `${num(n)} ${plural(n, "zadatka", "zadatka", "zadataka")}`;

/** "28. ruj – 4. lis 2026.": lokalni dani (tjedan plana) ili UTC dani (prozori iz A6). */
const dayRange = (from: string, toExclusive: string, utc = false) => {
  const last = new Date(Date.parse(toExclusive) - 1);
  const zone = utc ? { timeZone: "UTC" } : {};
  const short = (date: Date) => date.toLocaleDateString("hr-HR", { day: "numeric", month: "short", ...zone });
  const long = (date: Date) => date.toLocaleDateString("hr-HR", { day: "numeric", month: "short", year: "numeric", ...zone });
  return `${short(new Date(from))} – ${long(last)}`;
};

const roles = { pfr: "kao preflop raiser", caller: "kao onaj koji je callao preflop" } as Record<string, string>;
const sides = { ip: "u poziciji", oop: "bez pozicije" } as Record<string, string>;
const pots = { srp: "u potovima s jednim raiseom", "3bp": "u 3-bet potovima", limped: "u limpanim potovima" } as Record<string, string>;

export const planHr = {
  heading: "Plan učenja",
  intro:
    "Na čemu raditi ovaj tjedan, i kako: situacije koje te najviše koštaju prema referenci, svaka s onim što trebaš pročitati, odigrati u treneru, svojim vježbama i vlastitim rukama za pregled. Svakog ponedjeljka novi se plan složi iz tvoje najnovije analize.",
  loading: "Učitavam tvoj plan…",
  building: "Slažem plan za ovaj tjedan iz tvojih leakova…",
  failed: (message: string) => `Plan se nije učitao: ${message}`,
  saveFailed: (message: string) => `Plan se nije mogao spremiti: ${message}`,
  tickFailed: (message: string) => `Ta kvačica nije spremljena: ${message}`,
  tryAgain: "Pokušaj ponovno",
  notInstalledHeading: "Planovi učenja još nisu postavljeni na ovoj bazi",
  notInstalledBefore: "Stižu s ",
  notInstalledAfter: ". Primijeni je i ponovno učitaj.",

  week: (from: string, toExclusive: string) => `Tjedan ${dayRange(from, toExclusive)}`,
  daysLeft: (days: number) =>
    days <= 1 ? "Zadnji dan tjedna" : `Još ${num(days)} ${plural(days, "dan", "dana", "dana")}`,
  progressLabel: "Napredak ovaj tjedan",
  progress: (done: number, total: number) => `Gotovo ${num(done)} od ${tasks(total)}`,
  builtOn: (date: string) =>
    `Složen ${new Date(date).toLocaleDateString("hr-HR", { day: "numeric", month: "short" })}.`,
  rebuild: "Složi ponovno iz najnovije analize",
  rebuilding: "Slažem ponovno…",
  rebuildNote: "Zadaci koji ostaju u planu zadržavaju svoje kvačice.",
  staleVersion: (planVersion: string, current: string) =>
    `Ovaj je plan složen iz ocjena verzije ${planVersion}; tvoja je analiza sada ${current}. Složi ga ponovno da plan prati nove ocjene.`,
  autoNote:
    "Situacije u treneru i vježbe same se označavaju dok ih ovaj tjedan igraš; pojmove i ruke označavaš sam. Bilo što možeš označiti i ručno.",

  focusHeading: "Fokus ovog tjedna",
  focusIntro: (areas: number) =>
    areas === 1
      ? "Jedina situacija na koju tvoj uzorak može s nešto pouzdanosti pokazati, i što s njom napraviti."
      : `${num(areas)} ${plural(areas, "situacija", "situacije", "situacija")} koje te koštaju najviše EV-a, najprije one za koje tvoj uzorak može jamčiti.`,
  area: {
    label: (index: number) => `Fokus ${num(index)}`,
    why: "Zašto je važno",
    numbers: (ev: number, per100: number, mistakeCount: number, spot: number) =>
      `${bb(ev)} izgubljeno, ${bb(per100)} na 100 ruku: ${mistakes(mistakeCount)} u ${decisionsLoc(spot)} ovdje.`,
    leak: (title: string, ev: number, mistakeCount: number) => `${title}: ${bb(ev)} (${mistakes(mistakeCount)})`,
    tentative: "Okvirno",
    tentativeNote: "Ovdje je malo ruku: možda je riječ o par loših ruku, a ne o leaku. Pregledaj ih prije nego što išta mijenjaš.",
    weeks: (weeks: number) => `${num(weeks)}. tjedan u fokusu`,
    openLeak: "Pogledaj u Leakovima",
    checklist: "Ovaj tjedan",
  },

  tasks: {
    read: "Pročitaj",
    train: (target: number, what: string) =>
      `Odigraj ${num(target)} ${plural(target, "situaciju", "situacije", "situacija")} u treneru: ${what}`,
    trainPreflop: (family: string, seat: string | null, vs: string | null) =>
      [family, seat ? `s pozicije ${seat}` : null, vs ? `kad raisea ${vs}` : null].filter(Boolean).join(", "),
    trainRiver: (role: string | null, side: string | null, pot: string | null) => {
      const parts = [role ? roles[role] : null, side ? sides[side] : null, pot ? pots[pot] : null].filter(Boolean);
      return parts.length > 0 ? `river, ${parts.join(", ")}` : "bilo koji river";
    },
    drill: (target: number) =>
      `Riješi ${num(target)} ${plural(target, "vježbu", "vježbe", "vježbi")} na redu iz ove situacije`,
    drillAll: (target: number) => `Riješi ${num(target)} ${plural(target, "vježbu", "vježbe", "vježbi")} na redu`,
    review: "Pregledaj svoju ruku",
    reviewDetail: (cards: string, position: string | null, ev: number | null, date: string | null) =>
      [cards || null, position, ev !== null && ev > 0 ? `−${bb(ev)}` : null, date].filter(Boolean).join(" · "),
    reviewUnknown: "jedna od tvojih ruku",
    counted: (n: number, target: number) => `${num(Math.min(n, target))} od ${num(target)}`,
    dueNow: (n: number) => (n > 0 ? `${num(n)} sada na redu` : "trenutno ništa na redu"),
    play: "Igraj",
    openPage: "Otvori",
    drillLink: "Vježbaj",
    openHand: "Otvori ruku",
    linkLabel: (action: string, task: string) => `${action} — ${task}`,
  },

  fundamentals: {
    heading: "Kreni od osnova",
    none: "Još nema ocijenjenih ruku, pa nema ni leaka oko kojeg bi se složio plan. Dok ga ne bude, ovo su osnove na kojima počiva svaki leak.",
    few: (moveCount: number, needed: number) =>
      `Zasad samo ${moves(moveCount)}: premalo da bi se leak razlikovao od slučaja. Dok ih ne bude ${num(needed)} ili više, kreni od osnova.`,
    noLeaks: "Nijedna situacija nije te koštala dovoljno da bi se oko nje složio tjedan. Drži osnove oštrima.",
    goToAnalysis: "Analiziraj svoje ruke",
  },

  retro: {
    heading: "Prošli tjedan",
    finished: (done: number, total: number, from: string, toExclusive: string) =>
      `Plan prošlog tjedna (${dayRange(from, toExclusive)}): gotovo ${num(done)} od ${tasks(total)}.`,
    first: "Ovo ti je prvi plan, pa nema prošlog tjedna za osvrt. Umjesto toga, evo kako se uspoređuje tvoja nedavna igra.",
    planWeek: (from: string, toExclusive: string, current: number, prior: number) =>
      `Tvoja ocijenjena igra za vrijeme prošlotjednog plana (${dayRange(from, toExclusive)}) prema tjednu prije: ${moves(current)} prema ${num(prior)}.`,
    lastPlay: (from: string, toExclusive: string, current: number, prior: number, afterPlan: boolean) =>
      `${afterPlan ? "Za vrijeme prošlotjednog plana nisi odigrao nijednu ocijenjenu ruku, pa evo tvojih" : "Tvojih"} zadnjih 7 dana igre (${dayRange(
        from,
        toExclusive,
        true,
      )}) prema 7 dana prije: ${moves(current)} prema ${num(prior)}.`,
    anchorNote: "Računa se unatrag od zadnjeg dana kad si igrao, ne od danas.",
    per100: (now: number | null, before: number | null) =>
      `Izgubljeni EV ovdje: ${now === null ? "—" : bb(now)} na 100 ruku, prema ${before === null ? "—" : bb(before)}.`,
    nothing: "Još nema ocijenjenih ruku za usporedbu.",
    areasHeading: (focusFromLastWeek: boolean) => (focusFromLastWeek ? "Fokus prošlog tjedna" : "Fokus ovog tjedna, nedavno"),
  },

  card: {
    heading: "Plan za ovaj tjedan",
    none: "Za ovaj tjedan još nema plana. Složit će se iz tvojih leakova za tren.",
    build: "Složi plan za ovaj tjedan",
    open: "Otvori svoj plan",
    fundamentals: "Osnove",
    focus: (names: string) => `Fokus: ${names}.`,
  },
};
