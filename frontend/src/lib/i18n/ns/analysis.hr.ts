import type { DecisionAnalysis, Flag, SpotFacts } from "../../analysis/types";
import { plural } from "../plural";
import type { Dict } from "../types";

/**
 * Strings for the Analysis tab and the replayer's Analysis sheet, Croatian.
 * Same shape as `analysis.en.ts`, including `explain()`, which builds the same
 * sentences from the same record — see the header of the English file.
 *
 * Poker words stay the ones Croatian players use (fold, call, bet, raise,
 * check, flop, turn, river, nuts, SPR, MDF); the sentences around them are
 * Croatian, addressed with "ti" like the rest of the app.
 */

const num = (value: number, digits = 0) =>
  value.toLocaleString("hr-HR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
/** Nominativ: 1 ruka, 2 ruke, 5 ruku. */
const hands = (count: number) => `${num(count)} ${plural(count, "ruka", "ruke", "ruku")}`;
/** Genitiv, iza "od": od 1 ruke, od 2 ruke, od 5 ruku. */
const handsGen = (count: number) => `${num(count)} ${plural(count, "ruke", "ruke", "ruku")}`;
/** 1 odluka, 2 odluke, 5 odluka. */
const decisions = (count: number) => `${num(count)} ${plural(count, "odluka", "odluke", "odluka")}`;
const decisionsGen = (count: number) => `${num(count)} ${plural(count, "odluke", "odluke", "odluka")}`;
const pct = (value: number) => `${num(Math.round(value * 100))} %`;
const bb = (value: number) => {
  const tenth = Math.round(value * 10) / 10;
  return `${num(tenth, tenth % 1 !== 0 ? 1 : 0)} bb`;
};

const streets = { preflop: "Preflop", flop: "Flop", turn: "Turn", river: "River" } as Record<string, string>;
const streetsLower = { preflop: "preflop", flop: "na flopu", turn: "na turnu", river: "na riveru" } as Record<
  string,
  string
>;

/** Akuzativ, iza "imaš": imaš set, imaš top par. */
const made = {
  "straight-flush": "skalu u boji",
  quads: "poker",
  "full-house": "full house",
  flush: "boju",
  straight: "skalu",
  set: "set",
  trips: "tris",
  "two-pair": "dva para",
  overpair: "overpar",
  "top-pair": "top par",
  "pocket-pair-below-top": "džepni par ispod najviše karte",
  "second-pair": "drugi par",
  "weak-pair": "slab par",
  underpair: "underpar",
  "ace-high": "asa kao najvišu kartu",
  "high-card": "samo visoke karte",
  board: "isto što i board",
} as Record<string, string>;

/** Instrumental with its preposition: "s" before most words, "sa" before an s-cluster. */
const kicker = { top: "s top kickerom", good: "s dobrim kickerom", weak: "sa slabim kickerom" } as Record<string, string>;

const draws = {
  "flush-draw": "flush draw",
  "nut-flush-draw": "nut flush draw",
  oesd: "otvoreni straight draw",
  gutshot: "gutshot",
  "backdoor-flush": "backdoor flush draw",
  "backdoor-straight": "backdoor straight draw",
  overcards: "dvije overkarte",
} as Record<string, string>;

/** Akuzativ, iza "blokiraju". */
const blockers = {
  "nut-flush": "nut flush",
  "second-nut-flush": "drugi najjači flush",
  "nut-straight": "nut skalu",
  "top-pair": "top par",
  set: "setove",
} as Record<string, string>;

const preflopScenarios = {
  unopened: "Neotvoreni pot",
  "vs-limp": "Protiv limpera",
  "bb-option": "Opcija big blinda",
  "vs-open": "Protiv otvaranja",
  squeeze: "Squeeze situacija",
  "vs-3bet": "Protiv 3-beta nakon otvaranja",
  "vs-3bet-cold": "Protiv 3-beta, hladno",
  "vs-4bet": "Protiv 4-beta ili više",
} as Record<string, string>;

const roles = { pfr: "Preflop raiser", caller: "Preflop caller", limped: "Limpani pot" } as Record<string, string>;
const facing = { first: "prvi na betu", "vs-bet": "protiv beta", "vs-raise": "protiv raisea" } as Record<string, string>;

function scenarioLabel(facts: Pick<SpotFacts, "preflopScenario" | "role" | "facing" | "inPosition" | "scenario">): string {
  if (facts.preflopScenario) return preflopScenarios[facts.preflopScenario] ?? facts.scenario;
  const where = facts.inPosition === null ? "" : facts.inPosition ? ", u poziciji" : ", izvan pozicije";
  return `${roles[facts.role ?? ""] ?? facts.scenario}${where}, ${facing[facts.facing ?? ""] ?? ""}`.replace(/, $/, "");
}

/** "open:BTN" → "BTN open". Genitiv iza "raspona": raspona BTN opena. */
const lines = {
  open: (pos: string) => `${pos} opena`,
  iso: (pos: string) => `izolacijskog raisea s ${pos}`,
  limp: (pos: string) => `${pos} limpa`,
  call: (pos: string) => `${pos} calla`,
  "3bet": (pos: string) => `${pos} 3-beta`,
  "call-3bet": (pos: string) => `${pos} calla na 3-bet`,
  "4bet": (pos: string) => `${pos} 4-beta`,
  "call-4bet": (pos: string) => `${pos} calla na 4-bet`,
  check: (pos: string) => `${pos} checka`,
  unknown: () => "bilo koje dvije karte",
} as Record<string, (pos: string) => string>;

function rangeLabel(key: string): string {
  const [line, position] = key.split(":");
  const label = lines[line] ?? lines.unknown;
  return label(position && position !== "?" ? position : "sjedala");
}

function handPhrase(facts: SpotFacts): string {
  if (!facts.made) return facts.handClass ?? facts.holeCards.join("");
  const base = made[facts.made.class] ?? facts.made.class;
  return facts.made.kicker ? `${base} ${kicker[facts.made.kicker]}` : base;
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} i ${items[items.length - 1]}`;
}

/** Predicative short forms: "Board je dvobojan, nepovezan, statičan." */
const textureWords = {
  suits: { rainbow: "rainbow", "two-tone": "dvobojan", monotone: "jednobojan" } as Record<string, string>,
  connectedness: {
    disconnected: "nepovezan",
    "semi-connected": "djelomično povezan",
    connected: "povezan",
  } as Record<string, string>,
  dynamism: { static: "statičan", medium: "umjereno dinamičan", dynamic: "dinamičan" } as Record<string, string>,
  highCard: { ace: "s asom", broadway: "visok", middle: "srednji", low: "nizak" } as Record<string, string>,
};

function textureLabel(facts: SpotFacts): string | null {
  const texture = facts.texture;
  if (!texture) return null;
  const words = [
    textureWords.highCard[texture.highCard],
    texture.trips ? "s trisom" : texture.paired ? "uparen" : null,
    textureWords.suits[texture.suits],
    textureWords.connectedness[texture.connectedness],
    texture.dynamism ? textureWords.dynamism[texture.dynamism] : null,
  ].filter((word): word is string => Boolean(word));
  return words.join(", ");
}

function flagSentence(flag: Flag, facts: SpotFacts): string {
  const p = flag.params;
  switch (flag.code) {
    case "fold-nuts":
      return facts.street === "river"
        ? "Foldao/la si nuts: nijedna ruka koju protivnik može imati ne pobjeđuje tvoju na ovom boardu."
        : "Foldao/la si ruku koja ne može izgubiti: ne pobjeđuje je nijedna ruka ni nijedna karta koja dolazi.";
    case "free-fold":
      return "Foldao/la si iako je check bio besplatan. Fold je bacio pot ni za što; check čuva sve opcije.";
    case "call-beats-nothing":
      return flag.severity === "inaccurate"
        ? "Ovaj call ne pobjeđuje ništa: nijedna ruka koju protivnik može imati nije slabija od tvoje."
        : `Ovaj call ne pobjeđuje ništa iz raspona ${rangeLabel(String(p.range))} — privremenog raspona, prije ikakvog sužavanja.`;
    case "call-without-odds":
      return `Za call je trebalo ${num(Number(p.needed))} % equityja, a tvoja ruka je imala oko ${num(Number(p.equity))} % protiv raspona ${rangeLabel(String(p.range))}, bez karata koje dolaze.`;
    case "fold-with-odds":
      return facts.street === "river"
        ? `Za call je trebalo ${num(Number(p.needed))} %, a tvoja ruka je imala oko ${num(Number(p.equity))} % čak i protiv jače polovice raspona ${rangeLabel(String(p.range))}.`
        : `Za call je trebalo ${num(Number(p.needed))} %, a tvoja ruka je imala oko ${num(Number(p.equity))} % protiv raspona ${rangeLabel(String(p.range))}, bez ičega što je ostalo za odlučiti.`;
    case "check-back-nuts":
      return "Checkao/la si nuts na riveru. Razlog može postojati — blocker, spojeni raspon — ali vrijedi pogledati: ništa ovdje ne pobjeđuje bet.";
    case "thin-stack-behind":
      return `Tvoj bet je ostavio ${bb(Number(p.behind))} iza, uz pot od ${bb(Number(p.pot))} ako bude callan: stack je praktički već uložen. All-in obično igra isto, a otkriva manje.`;
    case "committed-fold":
      return `Foldao/la si s ${num(Number(p.invested))} % stacka već u potu, uz cijenu za koju je trebalo samo ${num(Number(p.needed))} % equityja.`;
    default:
      return "";
  }
}

function explain(decision: DecisionAnalysis): string[] {
  const facts = decision.facts;
  const out: string[] = [];
  if (decision.status === "not-analysed") {
    out.push(
      decision.reason === "multiway"
        ? "Nije analizirano: nakon flopa u ruci su bila tri ili više igrača, a ništa ovdje ne modelira tri raspona odjednom. Bolje ne reći ništa nego reći nešto krivo."
        : "Nije analizirano.",
    );
  }

  const spot = scenarioLabel(facts);
  if (facts.street === "preflop") {
    out.push(`${spot} na ${facts.position ?? "tvojem sjedalu"} s ${facts.handClass ?? facts.holeCards.join("")}, efektivno ${bb(facts.effStackBb)}.`);
  } else {
    const texture = textureLabel(facts);
    const drawText = facts.draws.length > 0 ? `, uz ${list(facts.draws.map((d) => draws[d] ?? d))}` : "";
    out.push(`${streets[facts.street]}: ${spot}. Imaš ${handPhrase(facts)}${drawText}.${texture ? ` Board je ${texture}.` : ""}`);
  }

  if (facts.potOdds !== null) {
    const mdf = facts.mdf !== null ? ` Minimalna obrana protiv ovog beta je ${pct(facts.mdf)}.` : "";
    out.push(`Za call od ${bb(facts.toCallBb)} u pot od ${bb(facts.potBb)} treba ${pct(facts.potOdds)} equityja.${mdf}`);
  }
  if (facts.equity) {
    const strong =
      facts.equity.strong !== null && facts.equity.strong !== undefined
        ? ` (${pct(facts.equity.strong)} protiv njegove jače polovice)`
        : "";
    out.push(
      `Protiv raspona ${rangeLabel(facts.equity.range)} — privremenog, nesuženog kasnijim betovima — tvoja ruka ima oko ${pct(facts.equity.value)}${strong}.`,
    );
  }
  if (facts.betPot !== null && (decision.action === "bet" || decision.action === "raise")) {
    out.push(`${decision.action === "bet" ? "Betao/la" : "Raiseao/la"} si ${pct(facts.betPot)} pota${facts.allIn ? ", all-in" : ""}.`);
  }
  if (facts.spr !== null && facts.spr <= 3 && facts.street !== "river") {
    out.push(`SPR ${num(facts.spr, 1)}: stackovi su kratki u odnosu na pot, pa ih sljedeći bet veže.`);
  }
  if (facts.blockers.length > 0) {
    out.push(`Tvoje karte blokiraju ${list(facts.blockers.map((b) => blockers[b] ?? b))}.`);
  }
  for (const flag of decision.flags) {
    out.push(flagSentence(flag, facts));
  }
  return out.filter(Boolean);
}

export const analysisHr: Dict["analysis"] = {
  tab: {
    heading: "Analiza",
    sample: (count: number, version: string) => `${hands(count)} · ${version}`,
    signInHeading: "Prijavi se da analiziraš svoje ruke",
    signInBody: "Analiza čita ruke iz tvoje biblioteke, pa joj treba račun kojem pripada. Vidiš je samo ti.",
    signIn: "Prijavi se",
    notInstalledHeading: "Analiza još nije postavljena na ovoj bazi",
    notInstalledBefore: "Tvoje ruke su na sigurnom — ovaj ekran čita vlastite tablice, koje stižu s ",
    notInstalledAfter: ". Primijeni je i ponovno učitaj stranicu.",
    loading: "Čitam tvoju analizu…",
    tryAgain: "Pokušaj ponovno",
    emptyHeading: "Još ništa nije analizirano",
    emptyBody:
      "Analiza prolazi kroz svaku odluku u tvojim spremljenim rukama: board, tvoju ruku, cijenu i provjere koje vrijede bez obzira na strategiju. Radi u ovoj kartici preglednika.",
    noHandsHeading: "U tvojoj biblioteci još nema ruku",
    noHandsBody: "Prvo učitaj hand history; analiza čita ruke koje si spremio/la.",
  },

  reference: {
    title: "Još nema referentne strategije",
    body:
      "Ocjene — od Savršeno do Gruba greška — stižu s preflop chartovima. Do tada svaka odluka pokazuje svoje činjenice i provjere koje su istinite bez obzira na strategiju. Oznaka je bilješka, nikad ocjena.",
  },

  run: {
    button: "Pokreni analizu",
    again: "Analiziraj nove ruke",
    update: "Ažuriraj analizu",
    stop: "Zaustavi",
    running: (done: number, target: number) =>
      target > 0 ? `Analiziram… ${num(Math.min(done, target))} od ${handsGen(target)}` : `Analiziram… ${hands(done)}`,
    finished: (count: number) => `Analizirano: ${hands(count)}.`,
    stopped: "Zaustavljeno. Pokreni ponovno i nastavit će gdje je stala.",
    failed: (message: string) => `Analiza se zaustavila: ${message}`,
    unreadable: (count: number) =>
      `${num(count)} ${plural(count, "ruku", "ruke", "ruku")} nije bilo moguće pročitati — to je bug u konverteru, ne u tvojoj datoteci.`,
    missing: (count: number, total: number) => `${num(count)} od ${handsGen(total)} još nije analizirano.`,
    versionChanged: (count: number, version: string) =>
      `Analiza se promijenila otkad su ove ruke analizirane (${hands(count)}, sada ${version}). Pokreni je ponovno da ih ažuriraš.`,
    note: "Radi u ovoj kartici. Tvoje ruke čitaju se iz tvoje biblioteke, a rezultati se u nju spremaju — kao ti.",
  },

  overview: {
    coverage: "Pokrivenost",
    full: { label: "Potpuno analizirane", hint: "Svaka odluka ima svoje činjenice i provjere" },
    partial: { label: "Djelomično analizirane", hint: "Neke odluke su preskočene — vidi dolje" },
    notAnalysed: { label: "Nisu analizirane", hint: "Izvan onoga što analiza pokriva" },
    hands,
    decisions,
    analysedDecisions: (analysed: number, total: number) => `analizirano ${num(analysed)} od ${decisionsGen(total)}`,
    reasonsHeading: "Zašto ruke nisu analizirane",
    skippedHeading: "Zašto su odluke preskočene",
    flagsHeading: "Oznake",
    flagsNote: "Provjere koje vrijede bez obzira na strategiju. Bilješke, ne ocjene — čitaj ih s otvorenom rukom.",
    noFlags: "U ovom uzorku ništa nije označeno.",
    flaggedHands: (count: number) => `${hands(count)} s oznakom`,
    streetsHeading: "Po streetovima",
    defenceNote:
      "Obranjeno: koliko si često nastavio/la (call ili raise) protiv beta, uz prosječni MDF tih betova. Jedan uzorak tvojih ruku — smjer, ne presuda.",
    approximationsHeading: "Aproksimacije",
  },

  reasons: {
    "no-hero": "Nema heroja (promatrani stol)",
    variant: "Nije Hold'em",
    "hi-lo": "Hi/Lo podijeljeni pot",
    limit: "Nije No-Limit",
    tournament: "Turnir (ICM se ne modelira)",
    "bomb-pot": "Bomb pot",
    "hero-cards-unknown": "Tvoje karte nisu poznate",
    "no-decisions": "Nisi imao/la nijednu odluku",
    multiway: "Više igrača nakon flopa",
  } as Record<string, string>,

  approximations: {
    heuristic: "Samo heurističke provjere, bez referentne strategije",
    "placeholder-range": "Equity protiv privremenih zadanih raspona",
    antes: "Ante u potu",
    straddle: "Straddle je pomaknuo blindove",
    "stack-depth": "Stackovi izvan 100 bb ±20 %",
    "table-size": "Nije stol za šest igrača",
  } as Record<string, string>,

  severity: { note: "Bilješka", inaccurate: "Netočno" } as Record<string, string>,

  flags: {
    "fold-nuts": "Fold s nutsom",
    "free-fold": "Fold kad je check bio besplatan",
    "call-beats-nothing": "Call s rukom koja ne pobjeđuje ništa",
    "call-without-odds": "Call bez izgleda",
    "fold-with-odds": "Fold s dobrim izgledima",
    "check-back-nuts": "Check s nutsom na kraju",
    "thin-stack-behind": "Bet je ostavio premalo iza",
    "committed-fold": "Fold s već uloženim stackom",
  } as Record<string, string>,

  grades: {
    perfect: "Savršeno",
    good: "Dobro",
    inaccurate: "Netočno",
    mistake: "Greška",
    blunder: "Gruba greška",
  } as Record<string, string>,

  streets,
  actions: { fold: "Fold", check: "Check", call: "Call", bet: "Bet", raise: "Raise" } as Record<string, string>,
  letters: { fold: "F", check: "X", call: "C", bet: "B", raise: "R" } as Record<string, string>,

  table: {
    street: "Street",
    decisions: "Odluke",
    analysed: "Analizirano",
    flagged: "Označeno",
    facingBet: "Protiv beta",
    defended: "Obranjeno",
    mdf: "MDF",
    hands: "Ruke",
    count: "Broj",
    flag: "Oznaka",
  },

  breakdown: {
    heading: "Raščlamba",
    splitBy: "Podijeli po",
    groups: {
      street: "Streetu",
      position: "Poziciji",
      pot_type: "Vrsti pota",
      scenario: "Situaciji",
    } as Record<string, string>,
    unknown: "Nepoznato",
    scenario: (key: string) => {
      if (preflopScenarios[key]) return preflopScenarios[key];
      const [role, where, ...rest] = key.split("-");
      const facingKey = rest.join("-");
      return `${roles[role] ?? role}, ${where === "ip" ? "IP" : "OOP"}, ${facing[facingKey] ?? facingKey}`;
    },
  },

  filters: {
    ariaLabel: "Filtriraj analizirane ruke",
    format: "Igra",
    street: "Street",
    anyStreet: "Bilo koji",
    flag: "Oznaka",
    anyFlag: "Bilo koja",
    flaggedOnly: "Bilo koja oznaka",
    status: "Pokrivenost",
    anyStatus: "Bilo koja",
    position: "Pozicija",
    anyPosition: "Bilo koja",
    potType: "Pot",
    anyPot: "Bilo koji",
    sort: "Poredak",
    sorts: {
      recent: "Najnovije prvo",
      oldest: "Najstarije prvo",
      flags: "Najviše oznaka",
      ev_loss: "Najveći gubitak EV-a",
      score: "Najniži rezultat",
      result: "Najveći gubitak",
    } as Record<string, string>,
    clear: "Očisti filtre",
  },

  list: {
    heading: "Ruke",
    total: (count: number) => hands(count),
    when: "Odigrano",
    hand: "Ruka",
    position: "Poz.",
    pot: "Pot",
    actions: "Odluke",
    flags: "Oznake",
    result: "Rezultat",
    open: (cards: string) => `Otvori analizu ruke ${cards}`,
    empty: "Nijedna analizirana ruka ne odgovara ovim filtrima.",
    previous: "Prethodna",
    next: "Sljedeća",
    page: (from: number, to: number, total: number) => `${num(from)}–${num(to)} od ${num(total)}`,
    noDate: "—",
    stripLabel: (parts: string[]) => parts.join(", "),
    decisionLabel: (street: string, action: string, mark: string | null) =>
      `${street} ${action.toLowerCase()}${mark ? ` — ${mark.toLowerCase()}` : ""}`,
    notAnalysed: "nije analizirano",
  },

  sheet: {
    title: "Analiza",
    toggle: "Analiza",
    toggleTitle: "Prikaži analizu ove ruke",
    notGraded: "Bez ocjene",
    notGradedHint: "Još nema referentne strategije — samo činjenice i provjere.",
    evLoss: "Gubitak EV-a",
    score: "Rezultat",
    approximate: "Približno",
    decisionsHeading: "Tvoje odluke",
    noDecisions: "U ovoj ruci nisi imao/la nijednu odluku.",
    factsHeading: "Situacija",
    flagsHeading: "Oznake",
    whyHeading: "Zašto",
    noFlags: "Ništa nije označeno: prošla je svaka provjera koja vrijedi bez obzira na strategiju.",
    skipped: "Preskočeno",
    mark: (street: string, action: string, note: string | null) =>
      `${street} ${action.toLowerCase()}${note ? `: ${note.toLowerCase()}` : ""}`,
    chip: (street: string, action: string) => `${street}: ${action}`,
    facts: {
      pot: "Pot",
      toCall: "Za call",
      potOdds: "Potreban equity",
      mdf: "MDF",
      spr: "SPR",
      betPot: "Veličina beta",
      effStack: "Efektivni stack",
      hand: "Tvoja ruka",
      board: "Board",
      draws: "Drawovi",
      blockers: "Blokira",
      equity: "Equity (procjena)",
      position: "Pozicija",
      spot: "Situacija",
    },
    bb,
    pct,
    ratio: (value: number) => num(value, 1),
    ofPot: (value: number) => `${pct(value)} pota`,
    equityValue: (value: number, range: string) => `${pct(value)} protiv ${rangeLabel(range)}`,
    handValue: (facts: SpotFacts) => handPhrase(facts),
    drawsValue: (facts: SpotFacts) => list(facts.draws.map((d) => draws[d] ?? d)),
    blockersValue: (facts: SpotFacts) => list(facts.blockers.map((b) => blockers[b] ?? b)),
    textureValue: (facts: SpotFacts) => textureLabel(facts) ?? "",
    spotValue: (facts: SpotFacts) => scenarioLabel(facts),
    streetLower: (street: string) => streetsLower[street] ?? street,
  },

  hand: {
    back: "Natrag na analizu",
    loading: "Učitavam ruku…",
    notFound: "Ova ruka nije u tvojoj biblioteci.",
    fresh:
      "Ova ruka još nije analizirana u trenutnoj verziji, pa je ovo svježa analiza izračunata u tvojem pregledniku. Pokreni analizu da je spremiš.",
  },

  explain,
};
