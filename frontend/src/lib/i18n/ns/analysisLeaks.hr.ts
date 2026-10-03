import { plural } from "../plural";
import type { Confidence, LeakKind, Mix, Trend } from "../../analysis/leaks";

/**
 * Strings for leaks and progress (phase A6), Croatian. Same shape as
 * `analysisLeaks.en.ts`. Poker words stay the ones Croatian players use
 * (fold, call, raise, bet, check, 3-bet, open, leak); the sentences around
 * them are Croatian, addressed with "ti". Seats stay UTG, HJ, CO, BTN, SB, BB.
 */

const ANY = "*";
const NONE = "-";

const num = (value: number, digits = 0) =>
  value.toLocaleString("hr-HR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const hands = (count: number) => `${num(count)} ${plural(count, "ruka", "ruke", "ruku")}`;
/** Lokativ iza "u": u 1 ruci, u 2 ruke, u 5 ruku. */
const handsLoc = (count: number) => `${num(count)} ${plural(count, "ruci", "ruke", "ruku")}`;
const moves = (count: number) =>
  `${num(count)} ${plural(count, "ocijenjeni potez", "ocijenjena poteza", "ocijenjenih poteza")}`;
const decisions = (count: number) => `${num(count)} ${plural(count, "odluka", "odluke", "odluka")}`;
const mistakes = (count: number) => `${num(count)} ${plural(count, "greška", "greške", "grešaka")}`;
/** Lokativ iza "u": u 1 odluci, u 2 odluke, u 5 odluka. */
const decisionsLoc = (count: number) => `${num(count)} ${plural(count, "odluci", "odluke", "odluka")}`;
/** Genitiv iza "od": od 1 odluke, od 2 odluke, od 5 odluka. */
const decisionsGen = (count: number) => `${num(count)} ${plural(count, "odluke", "odluke", "odluka")}`;
const pct = (value: number) => {
  const p = value * 100;
  return p > 0 && p < 10 ? `${num(Math.round(p * 10) / 10, 1)}\u00a0%` : `${num(Math.round(p))}\u00a0%`;
};
const bb = (value: number) => `${num(value, Math.abs(value) < 10 ? 2 : 1)} bb`;
const score = (value: number) => num(value, 1);
const signed = (value: number, digits = 1) => {
  const rounded = Math.round(value * 10 ** digits) / 10 ** digits;
  const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "±";
  return `${sign}${num(Math.abs(rounded), digits)}`;
};

const streets = { preflop: "Preflop", flop: "Flop", turn: "Turn", river: "River" } as Record<string, string>;
const streetsIn = { preflop: "preflop", flop: "na flopu", turn: "na turnu", river: "na riveru" } as Record<string, string>;
const actionWords = { fold: "Fold", check: "Check", call: "Call", bet: "Bet", raise: "Raise" } as Record<string, string>;

const kinds: Record<LeakKind, string> = {
  "fold-too-much": "Previše foldaš",
  "call-too-wide": "Callaš preširoko",
  "call-not-raise": "Callaš umjesto da dižeš",
  "raise-too-wide": "Dižeš preširoko",
  "raise-not-call": "Dižeš umjesto da callaš",
  "check-not-bet": "Checkaš umjesto da betaš",
  "bet-not-check": "Betaš umjesto da checkaš",
  "check-not-raise": "Checkaš umjesto da dižeš",
  "wrong-size": "Kriva veličina beta",
  "fold-free-check": "Foldaš kad možeš checkati",
  other: "Odstupaš od reference",
};

interface Where {
  street: string;
  scenario: string;
  family: string;
  hero: string;
  villain: string;
  /** `"9max"`: situacija s full-ring charta (A2d), imenovana sa stolom. */
  table?: string;
}

const known = (part: string) => part !== ANY && part !== NONE;

function title(kind: LeakKind, where: Where): string {
  if (where.street === "preflop") {
    if (kind === "raise-too-wide" && (where.scenario === "unopened" || where.family === "first-in")) return "Otvaraš preširoko";
    if (kind === "fold-too-much" && where.scenario === "unopened") return "Otvaraš preusko";
    if (kind === "raise-too-wide") return "3-betaš preširoko";
    if (kind === "raise-not-call") return "Re-raiseaš umjesto da callaš";
    if (kind === "wrong-size") return "Kriva veličina raisea";
  } else if (kind === "raise-too-wide" && where.family === "first") {
    return "Betaš prečesto";
  }
  return kinds[kind];
}

const roleWords = { pfr: "kao preflop raiser", caller: "kao preflop caller", limped: "u limpanom potu" } as Record<string, string>;
const facingWords = { first: "prvi na potezu", "vs-bet": "protiv beta", "vs-raise": "protiv raisea" } as Record<string, string>;

const capital = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** "BB protiv BTN opena", "CO prvi ulazi"; full ring to kaže: "UTG prvi ulazi (9-max)". */
function context(where: Where): string {
  const text = spotContext(where);
  return where.table === "9max" && known(where.hero) ? `${text} (9-max)` : text;
}

/** "BB protiv BTN opena", "CO prvi ulazi", "Kao preflop raiser, u poziciji, prvi na potezu". */
function spotContext(where: Where): string {
  const hero = known(where.hero) ? where.hero : null;
  const villain = known(where.villain) ? where.villain : null;
  const lead = hero ? `${hero} ` : "";
  if (where.street === "preflop") {
    switch (where.scenario) {
      case "unopened":
        return hero ? `${hero} prvi ulazi` : "Prvi ulaziš";
      case "vs-open":
        return capital(`${lead}protiv ${villain ? `${villain} opena` : "opena"}`);
      case "squeeze":
        return capital(`${lead}protiv ${villain ? `${villain} opena` : "opena"} i calla`);
      case "vs-3bet":
        return `${hero ? `${hero} open` : "Open"} protiv ${villain ? `${villain} 3-beta` : "3-beta"}`;
      case "vs-3bet-cold":
        return capital(`${lead}protiv ${villain ? `${villain} 3-beta` : "3-beta"}, hladno`);
      case "vs-4bet":
        return capital(`${lead}protiv ${villain ? `${villain} 4-beta` : "4-beta"}`);
      case "bb-option":
        return villain && villain !== "SB" ? `Opcija BB-a nakon ${villain} limpa` : "Opcija BB-a nakon limpova";
      case "vs-limp":
        return capital(`${lead}protiv ${villain ? `${villain} limpa` : "limpera"}`);
      default:
        break;
    }
    if (where.family === "first-in") return "Prvi ulaziš";
    if (where.family === "vs-raise") return "Protiv opena";
    if (where.family === "vs-reraise") return "Protiv 3-beta ili više";
    return "Bilo koja situacija";
  }
  const match = /^(pfr|caller|limped)-(ip|oop)-(first|vs-bet|vs-raise)$/.exec(where.scenario);
  if (match) {
    const text = [roleWords[match[1]], match[2] === "ip" ? "u poziciji" : "izvan pozicije", facingWords[match[3]]].join(", ");
    return `${capital(text)}${hero ? ` (${hero})` : ""}`;
  }
  if (known(where.family)) return capital(facingWords[where.family] ?? where.family);
  return "Bilo koja situacija";
}

function mix(value: Mix): string {
  const total = Object.values(value).reduce((sum, n) => sum + n, 0);
  if (total === 0) return "—";
  return (Object.entries(value) as Array<[string, number]>)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([action, n]) => `${actionWords[action] ?? action} ${pct(n / total)}`)
    .join(" · ");
}

const confidence: Record<Confidence, string> = {
  low: "Niska pouzdanost",
  medium: "Srednja pouzdanost",
  high: "Visoka pouzdanost",
};

const trends: Record<Trend, string> = {
  better: "Bolje",
  "leaning-better": "Naginje boljem",
  steady: "Bez jasne promjene",
  "leaning-worse": "Naginje gorem",
  worse: "Lošije",
  "too-few": "Premalo za reći",
};

const trendNotes: Record<Trend, string> = {
  better: "promjena veća od one koju obično napravi sama sreća.",
  "leaning-better": "u dobrom smjeru, ali to može biti i sama sreća.",
  steady: "unutar onoga što napravi sama sreća.",
  "leaning-worse": "u lošem smjeru, ali to može biti i sama sreća.",
  worse: "promjena veća od one koju obično napravi sama sreća.",
  "too-few": "premalo odluka u jednom od razdoblja da bi se išta reklo.",
};

const dateRange = (from: string, to: string) => {
  const format = (iso: string) =>
    new Date(iso).toLocaleDateString("hr-HR", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return `${format(from)} – ${format(to)}`;
};

export const leaksHr = {
  heading: "Leakovi",
  intro:
    "Situacije u kojima gubiš najviše EV-a u odnosu na referencu: tvoje ocijenjene odluke grupirane po streetu, situaciji, poziciji i onome što si napravio umjesto najboljeg poteza reference, najskuplje prve.",
  loading: "Tražim tvoje leakove…",
  notInstalledHeading: "Leakovi još nisu postavljeni na ovoj bazi",
  notInstalledBefore: "Stižu s migracijom ",
  notInstalledAfter: ". Primijeni je i ponovno učitaj stranicu.",
  emptyHeading: "Još ništa nije ocijenjeno",
  emptyBody:
    "Leakovi nastaju iz ocijenjenih odluka: preflop prema našim chartovima, river prema našem solveru. Prvo pokreni analizu svojih ruku.",
  goToAnalysis: "Idi na svoju analizu",
  noneInScope: "Nijedna ocijenjena odluka ne odgovara ovim filtrima.",
  noLeaks: "Nijedna situacija u ovom uzorku nije koštala više od greške zaokruživanja. Proširi filtre ili odigraj više ruku.",
  sample: (graded: number, handCount: number) => `${moves(graded)} u ${handsLoc(handCount)}`,
  total: (ev: number, per100: number, count: number) =>
    `${bb(ev)} izgubljeno u ${num(count)} ${plural(count, "leaku", "leaka", "leakova")} — ${bb(per100)} na 100 ruku.`,

  how: {
    toggle: "Kako se leakovi traže",
    title: "Kako se leakovi traže",
    spot: "Situacija je street, scenarij (prvi ulaziš, protiv opena, preflop raiser izvan pozicije protiv beta…), tvoja pozicija i, preflop, igrač protiv kojeg igraš. Leak je jedno krivo skretanje u njoj: ono što si napravio tamo gdje je najbolji potez reference bio drugi — ili pravi potez krive veličine.",
    frequency:
      "Puta u situaciji broji svaku ocijenjenu odluku koju si ondje donio, dobru ili lošu; greške su one ocijenjene lošije od Perfect. Izgubljeni EV je zbroj njihovog gubitka u odnosu na najbolji potez reference.",
    merge:
      "Situacije u kojima si bio manje od 10 puta spajaju se u sljedeću grublju — prvo otpada pozicija protivnika, zatim tvoja, pa točan scenarij — da šačica ruku ne postane zaseban leak. Spojeni red to i kaže.",
    confidence:
      "Pouzdanost je uzorak: visoka traži 50 odluka u situaciji i 5 grešaka, srednja 20 i 2. Leak niske pouzdanosti može biti jedna loša ruka.",
    reference:
      "Referenca su naši 6-max 100 bb chartovi preflop i naš solver na riveru (na rasponima suženima modelom). Odluke na flopu i turnu još se ne ocjenjuju pa se ovdje ne mogu pojaviti.",
  },

  controls: {
    street: "Street",
    anyStreet: "Svi streetovi",
    sort: "Poredaj po",
    sorts: {
      ev: "Ukupno izgubljeni EV",
      "per-spot": "Izgubljeni EV po situaciji",
      mistakes: "Greške",
    } as Record<string, string>,
  },

  streets,
  streetsIn,
  actions: actionWords,
  kinds,
  title,
  context,
  name: (titleText: string, contextText: string, street: string) => `${titleText} — ${contextText} · ${streets[street] ?? street}`,
  fullContext: (where: Where, level: number, partial: boolean) =>
    !partial
      ? context(where)
      : level >= 4
        ? "Ostale situacije"
        : `${context(where)} · ${level <= 1 ? "ostali protivnici" : level === 2 ? "ostale pozicije" : "ostale situacije"}`,

  columns: {
    leak: "Leak",
    evLost: "Izgubljeni EV",
    per100: "na 100 ruku",
    spot: "Puta u situaciji",
    mistakes: "Greške",
    perMistake: "po grešci",
    confidence: "Pouzdanost",
  },
  bb,
  pct,
  rank: (index: number) => `${num(index)}.`,
  evLost: (ev: number) => `${bb(ev)} izgubljeno`,
  per100: (value: number) => `${bb(value)} / 100 ruku`,
  spotTimes: (mistakeCount: number, spotCount: number) => `${mistakes(mistakeCount)} u ${decisionsLoc(spotCount)}`,
  perMistake: (value: number) => `${bb(value)} po grešci`,
  confidence,
  confidenceHint: (spotCount: number, mistakeCount: number) =>
    `${decisions(spotCount)} u ovoj situaciji, ${mistakes(mistakeCount)}`,
  showAll: (count: number) => `Prikaži sve leakove (${num(count)})`,
  showFewer: "Prikaži manje",
  expand: (name: string) => `Prikaži detalje: ${name}`,

  detail: {
    describe: (contextText: string, streetIn: string, mistakeCount: number, spotCount: number, ev: number) =>
      `${contextText}, ${streetIn}: od najboljeg poteza reference odstupio si u ${num(mistakeCount)} od svojih ${decisionsGen(spotCount)} i izgubio ${bb(ev)}.`,
    youDid: "Što si ovdje radio",
    referenceDoes: "Što referenca radi s tvojim rukama",
    mixNote:
      "Preko svih tvojih odluka u ovoj situaciji: tvoje akcije i najbolji potez reference za ruku koju si svaki put imao — pošteno uspoređivanje, jer tvoje ruke nisu podijeljene iz njezina raspona.",
    mix,
    best: (action: string) => `Najbolji potez reference u ovom leaku: ${actionWords[action] ?? action}.`,
    merged: (count: number) =>
      `Spojeno iz ${num(count)} ${plural(count, "manje situacije", "manje situacije", "manjih situacija")}, svaka ispod 10 odluka.`,
    partial: "Situacije s dovoljno ruku imaju svoj red; ovaj skuplja ostatak.",
    numbers: "Brojke",
    seriousNote: (count: number) => `Od toga ${num(count)} Inaccurate ili lošije.`,
    per100: (value: number) => `${bb(value)} na 100 ruku`,
    perSpot: (value: number) => `${bb(value)} po situaciji`,
    perMistake: (value: number) => `${bb(value)} po grešci`,
    lowNote: "Niska pouzdanost: nekoliko ruku, možda jedna. Otvori ih prije nego što išta mijenjaš.",
    drill: "Vježbaj ovo",
  },

  hands: {
    heading: "Tvoje ruke u ovoj situaciji",
    note: "Najviše izgubljenog EV-a prvo. Otvori ruku da je ponovo pogledaš s analizom te odluke.",
    loading: "Učitavam ruke…",
    empty: "Nema ruku za prikaz.",
    failed: (message: string) => `Ruke se nisu učitale: ${message}`,
    open: (what: string) => `Otvori ruku: ${what}`,
    took: (action: string, best: string) => `${action}, najbolje ${best}`,
    evLoss: (value: number) => `−${bb(value)}`,
    more: "Još ruku",
    total: (count: number) => `${hands(count)} u ovom leaku`,
  },
};

export const progressHr = {
  heading: "Napredak",
  intro:
    "Tvoj score i EV koji gubiš na 100 ruku kroz vrijeme, uz broj ocijenjenih poteza u svakom razdoblju — po želji podijeljeno po streetu, poziciji ili vrsti pota. Razdoblje s malo ocijenjenih poteza ljulja se zbog sreće; njegove točke su šuplje.",
  loading: "Čitam tvoj napredak…",
  emptyHeading: "Još ništa nije ocijenjeno",
  emptyBody: "Napredak se crta iz ocijenjenih odluka. Prvo pokreni analizu svojih ruku.",
  goToAnalysis: "Idi na svoju analizu",
  noneInScope: "Nijedna ocijenjena odluka s datumom ne odgovara ovim filtrima.",
  notEnough: "Za crtu trebaju dva razdoblja s ocijenjenim potezima. Probaj kraće razdoblje ili šire filtre.",
  sample: (graded: number, buckets: number, bucketWord: string) => `${moves(graded)} u ${num(buckets)} ${bucketWord}`,

  controls: {
    bucket: "Grupiraj po",
    buckets: { week: "Tjedan", month: "Mjesec", session: "Sesija" } as Record<string, string>,
    bucketsPlural: { week: "tjedana", month: "mjeseci", session: "sesija" } as Record<string, string>,
    group: "Podijeli po",
    groups: { all: "Ničemu", street: "Streetu", position: "Poziciji", pot_type: "Vrsti pota" } as Record<string, string>,
    metric: "Prikaži",
    metrics: { score: "Score", ev: "Izgubljeni EV / 100 ruku", off: "Potezi izvan reference" } as Record<string, string>,
  },
  sessionNote: (minutes: number) =>
    `Sesija su ruke međusobno udaljene najviše ${num(minutes)} minuta, preko svih stolova — pravilo sa zaslona statistike.`,

  charts: {
    score: "Score",
    scoreHint: "Prosjek ocijenjenih poteza, 0–100, s intervalom od 95\u00a0%",
    ev: "Izgubljeni EV na 100 ruku",
    evHint: "U odnosu na najbolji potez reference, u big blindovima",
    off: "Potezi izvan reference",
    offHint: "Udio ocijenjenih poteza lošijih od Perfect",
    volume: "Ocijenjeni potezi",
    thin: (min: number) => `Šuplje točke: manje od ${num(min)} ocijenjenih poteza.`,
    aria: (name: string, count: number) => `${name}, ${num(count)} ${plural(count, "točka", "točke", "točaka")}. Brojke su u tablici ispod.`,
    keys: "Strelicama lijevo i desno pomičeš se između točaka.",
    showNumbers: "Prikaži brojke",
    when: "Kada",
    moves: "Potezi",
    hands: "Ruke",
    interval: (low: number, high: number) => `95\u00a0%: ${score(low)}–${score(high)}`,
  },
  score,
  tick: (value: number) => num(value, Number.isInteger(value) ? 0 : 1),
  bb,
  pct,
  moves,
  dateRange,
  unknown: "Nepoznato",
  smallMultiplesNote: "Jedan graf po grupi, najveća prva. Grupe s ukupno manje od 20 ocijenjenih poteza su izostavljene.",
  left: (count: number) => `${plural(count, "Izostavljena je", "Izostavljene su", "Izostavljeno je")} ${num(count)} ${plural(count, "manja grupa", "manje grupe", "manjih grupa")}.`,
};

export const summaryHr = {
  heading: "Što se promijenilo",
  period: "Usporedi",
  periods: { 7: "Zadnjih 7 dana", 30: "Zadnjih 30 dana" } as Record<string, string>,
  loading: "Uspoređujem…",
  failed: (message: string) => `Usporedba se nije učitala: ${message}`,
  none: "Još nema ničeg ocijenjenog za usporedbu.",
  window: (days: number, from: string, to: string, current: number, prior: number) =>
    `Tvojih zadnjih ${num(days)} dana igre (${dateRange(from, to)}) prema ${num(days)} dana prije: ${moves(current)} prema ${num(prior)}.`,
  anchorNote: "Računa se unatrag od zadnjeg dana kad si igrao, ne od danas.",
  thin: (count: number) => `U ovom razdoblju samo ${moves(count)}: svaki red ovdje čitaj kao naznaku, ne kao presudu.`,
  overall: (now: number, before: number) => `Score ${score(now)} prema ${score(before)} (${signed(now - before)})`,
  street: (name: string, now: number | null, before: number | null) =>
    `${name}: ${now !== null ? score(now) : "—"} prema ${before !== null ? score(before) : "—"}`,
  trends,
  trendNotes,
  improvedHeading: "Što je bolje",
  improvedNone: "Ništa se nije popravilo dovoljno jasno da bi se to moglo reći. To je normalno u kratkom razdoblju.",
  workHeading: "Na čemu raditi",
  workNone: "Nijedan leak u ovom razdoblju nije koštao ništa vrijedno spomena.",
  rate: (nowMade: number, nowN: number, beforeMade: number, beforeN: number) =>
    `Greške u ${nowN > 0 ? pct(nowMade / nowN) : "—"} tvojih odluka ovdje (${num(nowMade)} od ${num(nowN)}), prema ${
      beforeN > 0 ? pct(beforeMade / beforeN) : "—"
    } (${num(beforeMade)} od ${num(beforeN)}) prije.`,
  cost: (ev: number, made: number, spot: number) => `${bb(ev)} izgubljeno, ${mistakes(made)} u ${decisionsLoc(spot)}.`,
  openLeak: (name: string) => `Otvori leak: ${name}`,
  allLeaks: "Svi leakovi",
  progress: "Napredak kroz vrijeme",
};
