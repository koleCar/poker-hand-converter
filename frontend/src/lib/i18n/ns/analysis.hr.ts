import { betterAlternative, modelCaveat, outOfRange, referenceMix } from "../../analysis/reference";
import type { DecisionAnalysis, Flag, OptionAnalysis, SpotFacts } from "../../analysis/types";
import { plural } from "../plural";
import type { Dict } from "../types";
import { reportsHr } from "./analysisReports.hr";
import { leaksHr, progressHr, summaryHr } from "./analysisLeaks.hr";
import { trainHr } from "./analysisTrain.hr";
import { shareHr } from "./analysisShare.hr";
import { planHr } from "./analysisPlan.hr";

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
const pct1 = (value: number) => {
  const p = value * 100;
  return p > 0 && p < 10 ? `${num(Math.round(p * 10) / 10, 1)} %` : `${num(Math.round(p))} %`;
};
const signedBb = (value: number) => {
  const rounded = Math.round(value * 100) / 100;
  const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "";
  return `${sign}${num(Math.abs(rounded), 2)} bb`;
};
/** 1 kombinacija, 2 kombinacije, 5 kombinacija. */
const combos = (count: number) => `${num(count)} ${plural(count, "kombinacija", "kombinacije", "kombinacija")}`;
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

function scenarioLabel(facts: Pick<SpotFacts, "preflopScenario" | "role" | "facing" | "inPosition" | "scenario" | "players">): string {
  if (facts.preflopScenario) return preflopScenarios[facts.preflopScenario] ?? facts.scenario;
  const multiway = facts.scenario.includes("-mw-");
  const where = multiway
    ? `, ${num(facts.players)} igrača${facts.scenario.includes("-mw-ip-") ? ", zadnji na potezu" : ""}`
    : facts.inPosition === null
      ? ""
      : facts.inPosition
        ? ", u poziciji"
        : ", izvan pozicije";
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
  if (line === "field") return `polja (${opponentsGen(Number(position))})`;
  const label = lines[line] ?? lines.unknown;
  return label(position && position !== "?" ? position : "sjedala");
}

/** Genitiv, iza "protiv": protiv 1 protivnika, protiv 2 protivnika. */
const opponentsGen = (count: number) => `${num(count)} protivnika`;
/** Nominativ: 1 protivnik, 2 protivnika, 5 protivnika. */
const opponentsNom = (count: number) => `${num(count)} ${plural(count, "protivnik", "protivnika", "protivnika")}`;

/** "raspona BTN opena", ili multiway (A9) "raspona polja (2 protivnika)". */
function rangeOf(key: string): string {
  return `raspona ${rangeLabel(key)}`;
}

const gradeWords = {
  perfect: "Savršeno",
  good: "Dobro",
  inaccurate: "Netočno",
  mistake: "Greška",
  blunder: "Gruba greška",
} as Record<string, string>;

/** "raise na 2,5 bb", "bet 3,1 bb (33 %)", "call", "all-in". */
function optionLabel(option: OptionAnalysis): string {
  if (option.allIn) return "all-in";
  // A preflop call to one big blind is a limp (charts/4 has them from every seat).
  if (option.action === "call" && option.sizeBb === 1) return "limp";
  if (option.action === "bet" && option.sizeBb !== undefined && option.sizePot !== undefined) {
    return `bet ${bb(option.sizeBb)} (${pct(option.sizePot)})`;
  }
  if (option.action === "raise" || option.action === "bet") {
    return option.sizeBb !== undefined ? `${option.action} na ${bb(option.sizeBb)}` : option.action;
  }
  return option.action;
}

function mixLabel(decision: DecisionAnalysis): string {
  return list(referenceMix(decision).map(({ option }) => `${optionLabel(option)} ${pct(option.freq)}`));
}

/** Kraj rečenice "Bez ocjene: …", po razlogu odbijanja chartova. */
const chartReasons = {
  "chart-straddle": "straddle mijenja svaku cijenu, a chartovi pokrivaju samo jedan: jedan straddle od 2 bb sa sjedala lijevo od big blinda, za 4-6 igrača, oko 100 bb",
  "chart-ante": "u potu je ante, a cash chartovi ga nemaju",
  "chart-players": "chartovi pokrivaju od tri do devet igrača (manji stol čita se uz foldane najranije pozicije); heads-up nije pokriven",
  "chart-stack-depth": "efektivni stack je više od 20 % udaljen od dubine svakog seta chartova (6-max: 40, 60, 100, 150, 200 bb; 9-max: 100, 150, 200 bb)",
  "chart-limp": "netko je open-limpao, a chartovi nemaju open limp osim small blinda",
  "chart-multiway": "ovo bi bio peti igrač u potu, više nego što chartovi modeliraju",
  "chart-cold-call": "hladni call na re-raise nije u stablu chartova",
  "chart-off-tree": "linija je izašla iz stabla betova u chartovima",
  "chart-rare-line": "linija je u ravnoteži prerijetka da bi bila u chartovima, na ovoj dubini stacka ili najbližima",
  "chart-action-not-modelled": "tvoja akcija ovdje nije jedna od opcija u chartovima",
  "chart-bad-input": "ruku nije bilo moguće smjestiti na chart",
  "chart-game": "chartovi pokrivaju samo No-Limit Hold'em cash",
  "chart-bomb-pot": "bomb pot nema preflop betanja",
  "chart-no-positions": "button nije poznat, pa ni pozicije",
  "chart-no-hero": "sjedalo heroja nema poziciju",
  "chart-no-decision": "odluka nije pronađena u čitanju ruke za chartove",
  "chart-unavailable": "chartovi nisu učitani",
} as Record<string, string>;

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Kraj rečenice "Bez ocjene: …" za river, po `RIVER_SKIP_REASONS`. */
const riverReasons = {
  "river-multiway-flop": "river je počeo s tri ili više igrača u potu, pa nema heads-up rivera koji bi se riješio",
  "river-range-unknown": "jedan igrač nema preflop liniju od koje bi raspon krenuo",
  "river-range-empty": "karte na boardu ispraznile su jedan raspon",
  "river-off-tree": "river linija izašla je iz solverova stabla betova (više raiseova nego što modelira)",
  "river-unreached": "riješene strategije s ovim rasponima gotovo nikad ne igraju ovu liniju, pa je strategija ovdje šum",
  "river-solve-failed": "solver nije mogao riješiti ovu situaciju",
} as Record<string, string>;

/** Kraj rečenice "Bez ocjene: …" za turn (A5a), po `TURN_SKIP_REASONS`. */
const turnReasons = {
  "turn-multiway-flop": "turn je počeo s tri ili više igrača u potu, pa nema heads-up turna koji bi se riješio",
  "turn-range-unknown": "jedan igrač nema preflop liniju od koje bi raspon krenuo",
  "turn-range-empty": "karte na boardu ispraznile su jedan raspon",
  "turn-off-tree": "turn linija izašla je iz solverova stabla betova (više raiseova nego što modelira)",
  "turn-unreached": "riješene strategije s ovim rasponima gotovo nikad ne igraju ovu liniju, pa je strategija ovdje šum",
  "turn-solve-failed": "solver nije mogao riješiti ovu situaciju",
} as Record<string, string>;

/** Kraj rečenice "Bez ocjene: …" za multiway odluku (A9), po `MULTIWAY_SKIP_REASONS`. */
const multiwayReasons = {
  multiway:
    "u potu su tri ili više igrača, a nijedan solver ne modelira tri raspona odjednom; približnu ocjenu dobiva samo call ili fold na flopu, turnu ili riveru protiv beta",
  "multiway-side-pot": "side pot (all-in za manje) dijeli showdown, a približni call to ne modelira",
  "multiway-crowded": "na bet je trebalo odgovoriti više od tri igrača",
  "multiway-range-unknown": "raspon jednog igrača nije se mogao provesti kroz ruku",
  "multiway-reraise":
    "ovo je re-raise na flopu ili turnu, a približni call ondje počiva na mjerenju flopova i turnova s najviše jednim raiseom",
} as Record<string, string>;

/** Kategorija realizacije na flopu (`made|d`), riječima. */
const realisationMade = {
  "fh+": "full house ili jače",
  flush: "flush",
  straight: "straight",
  set: "set",
  trips: "trips",
  "two-pair": "dva para",
  overpair: "overpair",
  "tp-top": "top par s top kickerom",
  "tp-good": "top par s dobrim kickerom",
  "tp-weak": "top par sa slabim kickerom",
  middle: "srednji par",
  weak: "slab par",
  "ace-high": "as high",
  nothing: "bez para",
} as Record<string, string>;

function realisationWords(category: string): string {
  const [made, draw] = category.split("|");
  return `${realisationMade[made] ?? made} ${draw === "d" ? "s drawom" : "bez drawa"}`;
}

/** *Zašto* približne multiway ocjene (A9; flop od analysis/15, turn od analysis/16): EV calla u odnosu na fold i na čemu počiva. */
function approxSentences(decision: DecisionAnalysis): string[] {
  const ev = decision.facts.multiway?.ev;
  if (decision.source !== "approx" || !ev || !decision.grade || decision.chosen === null) return [];
  const out: string[] = [];
  const word = gradeWords[decision.grade] ?? decision.grade;
  const better = ev.call > 0 ? "call" : "fold";
  out.push(
    `${word} (približno, multiway): protiv raspona kako su suženi, call vrijedi ${signedBb(ev.call)} u odnosu na fold, pa je ${better} bolji od to dvoje.`,
  );
  if (decision.grade !== "perfect" && decision.evLoss !== null) {
    out.push(
      `${decision.action === "fold" ? "Fold" : "Call"} košta ${bb(decision.evLoss)} (${pct(decision.evLossPot ?? 0)} pota)${ev.realisation ? " iznad margine modela (niže)" : ""}.`,
    );
  }
  const respond = ev.respond.map((r) => `${r.position ?? "jedan igrač"} calla u oko ${pct(r.call)} slučajeva`);
  const real = ev.realisation;
  if (real) {
    const where = real.ip >= 0.999 ? "u poziciji" : real.ip <= 0.001 ? "izvan pozicije" : `u poziciji u ${pct(real.ip)} slučajeva`;
    out.push(
      `Ako callaš, tvoja ruka ima ${pct(ev.equity)} equityja protiv polja u potu od oko ${bb(ev.pot)}${respond.length > 0 ? `, dok ${list(respond)}` : ""}.`,
    );
    if (real.model.startsWith("turnsolve")) {
      out.push(
        `Dolazi još jedna karta, pa je udio pota koji će ruka osvojiti taj equity puta ${real.factor.toFixed(2)}: koliko ${realisationWords(real.category)} realizira ${where} protiv beta na turnu, izmjereno na Railovim vlastitim heads-up rješenjima turna.`,
      );
    } else {
      out.push(
        `Dolaze još dvije karte, pa je udio pota koji će ruka osvojiti taj equity puta ${real.factor.toFixed(2)}: koliko ${realisationWords(real.category)} realizira ${where} protiv beta na flopu, izmjereno na Railovoj heads-up biblioteci flopova.`,
      );
    }
    if (real.allIn) {
      out.push(
        `${real.allIn >= 0.999 ? "Nakon calla" : `U ${pct(real.allIn)} slučajeva nakon calla`} nema više nikoga tko može betati (all-in), pa je udio upravo ono što call osvaja.`,
      );
    }
    out.push(
      `To mjerenje od ruke do ruke griješi za nekoliko posto pota, pa se potezu računa samo gubitak EV-a veći od ${pct(real.margin)} pota.`,
    );
  } else {
    out.push(
      `Ako callaš, tvoja ruka u prosjeku osvaja ${pct(ev.equity)} showdown pota od oko ${bb(ev.pot)}${respond.length > 0 ? `, dok ${list(respond)}` : ""}.`,
    );
  }
  out.push(
    "Igrači koji su još na potezu callaju ili foldaju prema modelu sužavanja i nikad ne re-raiseaju, a raise nije među uspoređenim opcijama: čitaj ovo kao procjenu, ne kao riješen odgovor.",
  );
  if (ev.capped) {
    out.push(
      `Samo po ovim brojevima ovo bi bila ${gradeWords[ev.capped] ?? ev.capped}. Rasponi suženi heurističkim modelom ne mogu nositi tu presudu, pa je ocjena ograničena na Grešku.`,
    );
  }
  if (decision.approximations.includes("range-sensitive") && ev.sensitivity) {
    out.push(
      `S rasponima suženima punom snagom ovo je ${gradeWords[ev.sensitivity.grade] ?? ev.sensitivity.grade}; upola slabije, ${gradeWords[decision.grade] ?? decision.grade}. Ocjena više ovisi o sužavanju nego o tvojoj ruci, pa je prikazana blaža.`,
    );
  }
  return out;
}

/** *Zašto* multiway činjenica (A9): stol, svaki raspon i polje, podjela MDF-a, fold equity i outovi. */
function multiwaySentences(decision: DecisionAnalysis): string[] {
  const facts = decision.facts;
  const mw = facts.multiway;
  const out: string[] = [];
  if (decision.approximations.includes("multiway-history") && (facts.river || facts.turn)) {
    out.push("Flop su vidjela tri ili više igrača; rješenje počinje ondje gdje je pot postao heads-up, od raspona suženih kroz multiway streetove.");
  }
  if (!mw || mw.players < 3) return out;
  out.push(
    mw.lastToAct
      ? `Pot s ${num(mw.players)} igrača, a ti si zadnji na potezu na ovom streetu.`
      : `Pot s ${num(mw.players)} igrača; iza tebe na ovom streetu na potezu je još ${opponentsNom(mw.behind)}.`,
  );
  const each = mw.opponents.filter((o) => o.equity !== null).map((o) => `${pct(o.equity ?? 0)} protiv ${rangeOf(o.range)}`);
  if (each.length > 0) {
    out.push(`Protiv svakog raspona zasebno tvoja ruka ima ${list(each)}.`);
  }
  if (mw.mdfSplit) {
    out.push(
      `Protiv ovog beta stol u cjelini treba braniti ${pct(mw.mdfSplit.mdf)}; podijeljeno na ${num(mw.mdfSplit.defenders)} igrača, svakom je dovoljno nastaviti u ${pct(mw.mdfSplit.each)} slučajeva (podjela MDF-a).`,
    );
  }
  if (mw.foldEquity) {
    out.push(
      `Tvoj bet je trebao da svi foldaju u ${pct(mw.foldEquity.needed)} slučajeva. Kad bi svaki foldao jednako često kao heads-up protiv ove veličine (${list(mw.foldEquity.each.map(pct))}), svi bi zajedno foldali oko ${pct(mw.foldEquity.all)}.`,
    );
  }
  if (mw.outs && (mw.outs.nut > 0 || mw.outs.nonNut > 0)) {
    out.push(
      `Od ${num(mw.outs.cards)} karata koje mogu doći, ${num(mw.outs.nut)} tvoju ruku čine nutsom, a ${num(mw.outs.nonNut)} daju skalu ili jače što i dalje nije nuts.`,
    );
  }
  if (mw.reverseImplied) {
    out.push("U multiway potu ti drugi najbolji outovi nose obrnute implied odds: kad dođu, veća je vjerojatnost da netko ima jaču ruku, a tada se gube veliki potovi.");
  }
  return out;
}

/**
 * Turn *zašto* (A5a): uloga ruke protiv raspona s kojim se suočava (value,
 * ruka kojoj treba zaštita, draw, bluff-catcher, srednja ruka, zrak),
 * realizacija equityja izvan pozicije, river karte koje mijenjaju board,
 * oblik raspona i na čemu rješenje počiva. Samo brojevi iz `facts.turn` i
 * `facts.texture`.
 */
function turnSentences(decision: DecisionAnalysis): string[] {
  const turn = decision.facts.turn;
  if (decision.source !== "solver" || !turn) return [];
  const out: string[] = [];
  const beats = pct(turn.heroBeats);
  const equity = pct(turn.equity);
  const v = turn.villain;
  switch (turn.role) {
    case "value":
      out.push(`Tvoja ruka pobjeđuje ${beats} protivnikova raspona ovdje i ostaje ispred na većini rivera (${equity} equityja): ruka koja želi da pot raste.`);
      break;
    case "vulnerable":
      out.push(
        `Tvoja ruka je sada ispred — pobjeđuje ${beats} protivnikova raspona — ali ${pct(turn.rivers.weak)} river karata pretvara je u gubitnika. Bet naplaćuje rukama koje te mogu prestići i oduzima im equity (zaštita).`,
      );
      break;
    case "draw":
      out.push(
        `Sada si iza — tvoja ruka pobjeđuje ${beats} protivnikova raspona — ali ${pct(turn.rivers.strong)} river karata čini je jakom: ukupno ${equity} equityja. Draw može betati kao semi-blef ili callati kad je cijena dobra.`,
      );
      break;
    case "bluff-catcher":
      out.push(`Protiv ovog beta tvoja ruka pobjeđuje ${beats} protivnikova raspona, ${equity} equityja s riverom koji tek dolazi: ispred blefova i drawova, iza value ruku.`);
      break;
    case "medium":
      out.push(`Srednja ruka: pobjeđuje ${beats} protivnikova raspona, ${equity} equityja s riverom koji tek dolazi. Više joj odgovara jeftin showdown nego velik pot.`);
      break;
    case "air":
      out.push(`Tvoja ruka ima ${equity} equityja protiv protivnikova raspona ovdje i malo joj rivera pomaže: dobiva uglavnom tako da bolje ruke foldaju.`);
      break;
  }
  if (decision.facts.inPosition === false && (turn.role === "draw" || turn.role === "medium" || turn.role === "bluff-catcher")) {
    out.push("Izvan pozicije realiziraš manje tog equityja: na riveru igraš prvi, prije nego vidiš što protivnik radi.");
  }
  const texture = decision.facts.texture;
  if (texture && texture.volatility !== null && texture.volatility >= 0.25) {
    out.push(
      `${pct(texture.volatility)} river karata mijenja ovaj board — dolazi boja ili skala, ili pada overkarta. To su karte na kojima bet sada priprema drugi barrel, za raspon koji ih drži.`,
    );
  }
  if (v.shape === "polar") {
    out.push(`Protivnikov raspon ovdje je polariziran: ${pct(v.strong)} jakih ruku i ${pct(v.weak)} slabih, malo toga između.`);
  } else if (v.shape === "merged") {
    out.push(`Protivnikov raspon ovdje je spojen: ${pct(v.medium)} su ruke srednje snage.`);
  }
  if (decision.approximations.includes("size-translated")) {
    out.push("Veličina beta u ovoj turn liniji pročitana je kao najbliža solverova veličina (75 % pota i all-in, raise 75 % i all-in, uz veličine iz ove ruke).");
  }
  if (turn.capped) {
    out.push(
      `Samo po solverovim brojevima ovo bi bila ocjena ${gradeWords[turn.capped] ?? turn.capped}. Rasponi koje je na flopu suzio heuristički model ne mogu nositi takvu presudu, pa je ocjena ograničena na Grešku — Gruba greška je samo potez koji gubi što god protivnik drži.`,
    );
  }
  if (decision.approximations.includes("range-sensitive") && turn.sensitivity) {
    out.push(
      `Sa sužavanjem na flopu punom snagom solver ovo ocjenjuje kao ${gradeWords[turn.sensitivity.grade] ?? turn.sensitivity.grade}; upola slabije, kao ${gradeWords[decision.grade ?? ""] ?? decision.grade}. Ocjena više ovisi o sužavanju nego o tvojoj ruci, pa je prikazana blaža.`,
    );
  }
  out.push(
    turn.converged
      ? `Oba raspona sužena su na flopu heurističkim modelom; turn je riješen kroz river — s jednom veličinom river beta i all-inom ispod njega — do ${num(turn.exploitabilityPct, 1)} % pota od ravnoteže.`
      : `Oba raspona sužena su na flopu heurističkim modelom, a rješavanje turna stalo je nakon ${num(turn.iterations)} iteracija, ${num(turn.exploitabilityPct, 1)} % pota od ravnoteže: tijesne odluke čitaj s rezervom.`,
  );
  return out;
}

/**
 * River *zašto* (A4): što je tvoja ruka protiv raspona s kojim se suočava,
 * oblik tog raspona, blokeri i na čemu rješenje počiva. Samo brojevi iz
 * `facts.river`.
 */
function riverSentences(decision: DecisionAnalysis): string[] {
  const river = decision.facts.river;
  if (decision.source !== "solver" || !river) return [];
  const out: string[] = [];
  const beats = pct(river.heroBeats);
  const v = river.villain;
  switch (river.role) {
    case "bluff-catcher":
      out.push(
        v.shape === "polar"
          ? `Protiv polariziranog raspona — ${pct(v.strong)} jakih, ${pct(v.weak)} slabih, malo između — tvoja ruka je bluff-catcher: pobjeđuje ${beats} onoga što dođe ovamo.`
          : `Tvoja ruka je ovdje bluff-catcher: pobjeđuje ${beats} protivnikova raspona u ovoj točki, a ${pct(v.strong)} tog raspona je jako.`,
      );
      break;
    case "weak":
      out.push(`Tvoja ruka pobjeđuje samo ${beats} protivnikova raspona u ovoj točki — ni većinu njegovih blefova.`);
      break;
    case "value":
      out.push(
        decision.facts.toCallBb > 0
          ? `Tvoja ruka pobjeđuje ${beats} protivnikova raspona u ovoj točki: ispred je većine onoga što beta.`
          : v.shape === "merged"
            ? `Tvoja ruka pobjeđuje ${beats} protivnikova raspona ovdje, a taj raspon je spojen (${pct(v.medium)} srednjih ruku): value bet plaćaju slabije ruke.`
            : `Tvoja ruka pobjeđuje ${beats} protivnikova raspona ovdje: ruka za value bet.`,
      );
      break;
    case "thin-value":
      out.push(`Tvoja ruka pobjeđuje ${beats} protivnikova raspona ovdje: u najboljem slučaju tanki value — da bi se bet isplatio, moraju platiti slabije ruke.`);
      break;
    case "showdown":
      out.push(`Tvoja ruka pobjeđuje ${beats} protivnikova raspona ovdje: dovoljno za showdown, rijetko dovoljno za bet.`);
      break;
    case "air":
      out.push(`Tvoja ruka pobjeđuje ${beats} protivnikova raspona ovdje: dobiva samo ako bolje ruke foldaju.`);
      break;
  }
  if (Math.abs(river.blocks.strong - river.blocks.weak) >= 0.05) {
    out.push(`Tvoje karte uklanjaju ${pct(river.blocks.strong)} protivnikovih jakih kombinacija i ${pct(river.blocks.weak)} njegovih slabih.`);
  }
  if (decision.approximations.includes("size-translated")) {
    out.push("Veličine betova u ovoj river liniji pročitane su kao najbliže solverove veličine (33 %, 75 %, 150 % pota, all-in).");
  }
  if (river.capped) {
    out.push(
      `Samo po solverovim brojevima ovo bi bila ocjena ${gradeWords[river.capped] ?? river.capped}. Rasponi suženi heurističkim modelom ne mogu nositi takvu presudu, pa je ocjena ograničena na Grešku — Gruba greška je samo potez koji gubi što god protivnik drži.`,
    );
  }
  if (decision.approximations.includes("range-sensitive") && river.sensitivity) {
    out.push(
      `S rasponima suženima punom snagom solver ovo ocjenjuje kao ${gradeWords[river.sensitivity.grade] ?? river.sensitivity.grade}; upola slabije, kao ${gradeWords[decision.grade ?? ""] ?? decision.grade}. Ocjena više ovisi o sužavanju nego o tvojoj ruci, pa je prikazana blaža.`,
    );
  }
  const narrowed =
    river.narrowing === "turn-solver"
      ? "Oba raspona sužena su na flopu heurističkim modelom, a na turnu riješenom turn strategijom"
      : "Oba raspona sužena su na flopu i turnu heurističkim modelom";
  out.push(
    river.converged
      ? `${narrowed}, a river je riješen do ${num(river.exploitabilityPct, 1)} % pota od ravnoteže.`
      : `${narrowed}, a rješavanje je stalo nakon ${num(river.iterations)} iteracija, ${num(river.exploitabilityPct, 1)} % pota od ravnoteže: tijesne odluke čitaj s rezervom.`,
  );
  return out;
}

function chartSentences(decision: DecisionAnalysis): string[] {
  if ((decision.source !== "chart" && decision.source !== "solver") || decision.chosen === null || !decision.grade) return [];
  const out: string[] = [];
  const chosen = decision.options[decision.chosen];
  if (!chosen) return out;
  const word = gradeWords[decision.grade] ?? decision.grade;
  const mix = referenceMix(decision);
  const solver = decision.source === "solver";
  const who = solver ? "solver" : "referenca";
  if (outOfRange(decision)) {
    out.push(
      solver
        ? `Tvoja ruka nije u tvojem rasponu suženom do ove točke; solver s njom igra ${mixLabel(decision)}.`
        : `Tvoja ruka je izvan referentnog raspona u ovoj situaciji; referenca s njom igra ${mixLabel(decision)}.`,
    );
  }
  const plays = mix.length > 1 ? `miješa ${mixLabel(decision)}` : `igra ${mixLabel(decision)}`;
  const better = betterAlternative(decision);
  if (decision.grade === "perfect") {
    out.push(`${word}: odigrao/la si ${optionLabel(chosen)}; ${who} ovdje ${plays}.`);
  } else if (decision.grade === "good") {
    out.push(`${word}: ${who} ovdje igra ${optionLabel(chosen)} u ${pct(chosen.freq)} slučajeva, a ukupno ${plays}.`);
  } else {
    out.push(
      `${word}: ${who} ${plays}. ${capitalise(optionLabel(chosen))} košta ${bb(decision.evLoss ?? 0)} (${pct(decision.evLossPot ?? 0)} pota)${
        better ? ` u odnosu na ${optionLabel(better)}` : ""
      }.`,
    );
  }
  if (decision.approximations.includes("off-tree-size")) {
    out.push(
      solver
        ? `Bet u ovoj ${decision.street === "turn" ? "turn" : "river"} liniji bio je daleko od veličina u solveru, pa je ocjena ograničena na Netočno.`
        : "Raise u ovoj liniji bio je daleko od veličine u chartovima, pa je ocjena ograničena na Netočno.",
    );
  }
  if (modelCaveat(decision)) {
    out.push(
      "Ovi chartovi još podcjenjuju nekoliko ruku koje dobivaju kroz implied odds — male parove, male suited konektore i A5s — te flat buttona protiv cutoff opena, pa ocjenu protiv igranja takve ruke čitaj kao naznaku, ne kao presudu.",
    );
  }
  return out;
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
        : `Ovaj call ne pobjeđuje ništa iz ${rangeOf(String(p.range))} — njegovog preflop raspona, prije ikakvog sužavanja.`;
    case "call-without-odds":
      return `Za call je trebalo ${num(Number(p.needed))} % equityja, a tvoja ruka je imala oko ${num(Number(p.equity))} % protiv ${rangeOf(String(p.range))}, bez karata koje dolaze.`;
    case "fold-with-odds":
      return facts.street === "river"
        ? `Za call je trebalo ${num(Number(p.needed))} %, a tvoja ruka je imala oko ${num(Number(p.equity))} % čak i protiv najjače četvrtine ${rangeOf(String(p.range))}.`
        : `Za call je trebalo ${num(Number(p.needed))} %, a tvoja ruka je imala oko ${num(Number(p.equity))} % protiv ${rangeOf(String(p.range))}, bez ičega što je ostalo za odlučiti.`;
    case "check-back-nuts":
      return "Checkao/la si nuts na riveru. Razlog može postojati — blocker, spojeni raspon — ali vrijedi pogledati: ništa ovdje ne pobjeđuje bet.";
    case "thin-stack-behind":
      return `Tvoj bet je ostavio ${bb(Number(p.behind))} iza, uz pot od ${bb(Number(p.pot))} ako bude callan: stack je praktički već uložen. All-in obično igra isto, a otkriva manje.`;
    case "committed-fold":
      return `Foldao/la si s ${num(Number(p.invested))} % stacka već u potu, uz cijenu za koju je trebalo samo ${num(Number(p.needed))} % equityja.`;
    case "multiway-bluff":
      return `Betao/la si u ${opponentsGen(Number(p.opponents))} s ${num(Number(p.equity))} % equityja protiv polja. Bet je trebao da svi foldaju u ${num(Number(p.needed))} % slučajeva; i kad bi svaki foldao jednako često kao heads-up, svi bi zajedno foldali tek oko ${num(Number(p.all))} %. U multiway potu blef treba puno više foldova.`;
    case "multiway-slowplay":
      return `${facts.toCallBb > 0 ? "Samo si callao/la" : "Checkao/la si"} s rukom: ${handPhrase(facts)}, uz oko ${num(Number(p.equity))} % protiv ${opponentsGen(Number(p.opponents))}. U multiway potu jaka je ruka ranjivija — više igrača drži karte koje je prestižu — pa bet ili raise kojim ih naplaćuješ obično vrijedi više od slowplaya.`;
    case "multiway-dominated-draw":
      return `Callao/la si velik dio stacka s drawom koji nije prema nutsu: za call je trebalo ${num(Number(p.needed))} %, a tvoja ruka je imala oko ${num(Number(p.equity))} % protiv ${opponentsGen(Number(p.opponents))}. S više igrača veća je vjerojatnost da netko ima jaču ruku kad draw dođe, a call cijelog stacka ne ostavlja implied odds koji bi to nadoknadili.`;
    default:
      return "";
  }
}

function explain(decision: DecisionAnalysis): string[] {
  const facts = decision.facts;
  const out: string[] = [];
  if (decision.status === "not-analysed") {
    const chartReason = decision.reason
      ? (chartReasons[decision.reason] ?? riverReasons[decision.reason] ?? turnReasons[decision.reason])
      : undefined;
    const multiwayReason = decision.reason ? multiwayReasons[decision.reason] : undefined;
    out.push(
      multiwayReason
        ? `Bez ocjene: ${multiwayReason}. Činjenice i bilješke ispod računate su protiv raspona svakog protivnika, suženog kroz ruku. Bolje ne reći ništa nego reći nešto krivo.`
        : chartReason
          ? `Bez ocjene: ${chartReason}. Bolje ne reći ništa nego reći nešto krivo.`
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

  out.push(...chartSentences(decision));
  out.push(...approxSentences(decision));
  out.push(...turnSentences(decision));
  out.push(...riverSentences(decision));
  out.push(...multiwaySentences(decision));

  if (facts.potOdds !== null) {
    // MDF je postflop pojam (§4): preflop se nikad ne navodi, ni iz starijeg retka.
    const mdf =
      facts.mdf !== null && facts.street !== "preflop" ? ` Minimalna obrana protiv ovog beta je ${pct(facts.mdf)}.` : "";
    out.push(`Za call od ${bb(facts.toCallBb)} u pot od ${bb(facts.potBb)} treba ${pct(facts.potOdds)} equityja.${mdf}`);
  }
  if (facts.equity) {
    const strong =
      facts.equity.strong !== null && facts.equity.strong !== undefined
        ? ` (${pct(facts.equity.strong)} protiv njegove najjače četvrtine)`
        : "";
    const source = facts.equity.source;
    out.push(
      source === "solver"
        ? `Protiv ${rangeOf(facts.equity.range)} kako ga solver igra ovom linijom do ovdje, tvoja ruka dobiva ${pct(facts.equity.value)} na showdownu${strong}.`
        : source === "narrowed"
          ? `Protiv ${rangeOf(facts.equity.range)}, suženog dosadašnjim betovima (heuristički model), tvoja ruka ima oko ${pct(facts.equity.value)}${strong}.`
          : source === "chart"
            ? `Protiv ${rangeOf(facts.equity.range)} kako ga igraju chartovi — nesuženog kasnijim betovima — tvoja ruka ima oko ${pct(facts.equity.value)}${strong}.`
            : `Protiv ${rangeOf(facts.equity.range)} — privremenog, nesuženog kasnijim betovima — tvoja ruka ima oko ${pct(facts.equity.value)}${strong}.`,
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
    updatedHeading: "Analiza ima novu verziju",
    updatedBody:
      "Tvoje ruke analizirala je starija verzija. Ova pokriva i multiway potove: činjenice i bilješke protiv raspona svakog protivnika, približnu ocjenu za call ili fold na riveru, i solver za turn ili river koji je postao heads-up. Ažuriraj svoje ruke da ih vidiš; radi u ovoj kartici, a rješavanje turna traje sekundu ili dvije po ruci, pa velika biblioteka potraje. Možeš početi s najnovijim rukama.",
    noHandsHeading: "U tvojoj biblioteci još nema ruku",
    noHandsBody: "Prvo učitaj hand history; analiza čita ruke koje si spremio/la.",
  },

  reference: {
    title: "Preflop se ocjenjuje prema našim chartovima, turn i river prema našem solveru",
    body:
      "Preflop odluke dobivaju ocjenu, od Savršeno do Gruba greška, prema Railovim vlastitim preflop chartovima (6-max od 40 do 200 bb, puni stol od 100 do 200 bb), gdje god chart pokriva situaciju. Turn i river odluke u heads-up potovima ocjenjuje naš vlastiti solver, na rasponima koje na flopu sužava heuristički model, a do rivera riješeni turn. Flop pokazuje svoje činjenice i provjere koje vrijede bez obzira na strategiju — oznaka je bilješka, nikad ocjena. Multiway potovi dobivaju činjenice protiv raspona svakog protivnika, a call ili fold na flopu, turnu ili riveru približnu ocjenu, označenu kao takvu.",
    model:
      "Chartovi (charts/2) flop vrednuju uz checkan flop, pa još podcjenjuju nekoliko ruku koje dobivaju kroz implied odds: UTG folda 22–55, 54s–87s i A5s, a button gotovo nikad ne flata cutoff open. Ocjene protiv igranja takvih ruku su stroge.",
    browse: "Pregledaj chartove",
  },

  run: {
    button: "Pokreni analizu",
    again: "Analiziraj nove ruke",
    update: "Ažuriraj analizu",
    stop: "Zaustavi",
    running: (done: number, target: number) =>
      target > 0 ? `Analiziram… ${num(Math.min(done, target))} od ${handsGen(target)}` : `Analiziram… ${hands(done)}`,
    finished: (count: number) => `Analizirano: ${hands(count)}.`,
    /** Nakon "Analiziram… 120 od 900 ruku": preostalo vrijeme po dosadašnjem tempu. */
    eta: (seconds: number) =>
      seconds < 60 ? "— još manje od minute" : `— još oko ${num(Math.round(seconds / 60))} min`,
    scopeLabel: "Analiziraj",
    scopeAll: (count: number) => `sve (${hands(count)})`,
    scopeRecent: (count: number) => `prvo najnovijih ${num(count)}`,
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
    gradesHeading: "Ocjene",
    score: "Bodovi",
    scoreHint: "Prosjek ocijenjenih poteza, 0–100",
    evLoss100: "Gubitak EV-a / 100 ruku",
    evLoss100Hint: (count: number) => `na ${handsGen(count)} s ocijenjenim potezom`,
    moves: "Ocijenjeni potezi",
    movesHint: (total: number) => `od ${decisionsGen(total)}`,
    badHands: (count: number) => `${hands(count)} s greškom ili grubom greškom`,
    showBad: "Prikaži ih",
    noGrades:
      "U ovom uzorku još ništa nije ocijenjeno. Preflop odluke ocjenjuju se gdje chartovi pokrivaju situaciju (od tri do devet igrača, 40–200 bb, bez open limpera), turn i river odluke u heads-up potovima solverom, a multiway call ili fold na flopu, turnu ili riveru približno.",
    byStreet: "Po streetovima",
    bb2: (value: number) => `${num(value, 2)} bb`,
    distribution: (parts: string[]) => parts.join(", "),
    share: (word: string, share: number) => `${word} ${pct1(share)}`,
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
    multiway: "Multiway: samo činjenice i bilješke",
    "multiway-side-pot": "Multiway: side pot",
    "multiway-crowded": "Multiway: četiri ili više na potezu",
    "multiway-range-unknown": "Multiway: raspon se nije mogao provesti",
    "multiway-reraise": "Multiway flop ili turn: protiv re-raisea",
    "chart-straddle": "Preflop chartovi: straddle",
    "chart-ante": "Preflop chartovi: ante",
    "chart-players": "Preflop chartovi: heads-up ili 10+ igrača",
    "chart-stack-depth": "Preflop chartovi: nema seta za ovu dubinu stacka",
    "chart-limp": "Preflop chartovi: open limp",
    "chart-multiway": "Preflop chartovi: peti igrač u potu",
    "chart-cold-call": "Preflop chartovi: hladni call na re-raise",
    "chart-off-tree": "Preflop chartovi: izvan stabla betova",
    "chart-rare-line": "Preflop chartovi: prerijetka linija",
    "chart-action-not-modelled": "Preflop chartovi: akcija nije modelirana",
    "chart-bad-input": "Preflop chartovi: nečitljiva linija",
    "chart-game": "Preflop chartovi: nije NLHE cash",
    "chart-bomb-pot": "Preflop chartovi: bomb pot",
    "chart-no-positions": "Preflop chartovi: pozicije nepoznate",
    "chart-no-hero": "Preflop chartovi: heroj bez pozicije",
    "chart-no-decision": "Preflop chartovi: odluka nije pronađena",
    "chart-unavailable": "Preflop chartovi: nisu učitani",
    "river-multiway-flop": "River: počeo multiway",
    "river-range-unknown": "River: raspon bez preflop linije",
    "river-range-empty": "River: prazan raspon",
    "river-off-tree": "River: izvan solverova stabla",
    "river-unreached": "River: linija koju rješenje ne igra",
    "river-solve-failed": "River: solver je odbio situaciju",
    "turn-multiway-flop": "Turn: počeo multiway",
    "turn-range-unknown": "Turn: raspon bez preflop linije",
    "turn-range-empty": "Turn: prazan raspon",
    "turn-off-tree": "Turn: izvan solverova stabla",
    "turn-unreached": "Turn: linija koju rješenje ne igra",
    "turn-solve-failed": "Turn: solver je odbio situaciju",
  } as Record<string, string>,

  approximations: {
    heuristic: "Postflop: samo heurističke provjere, bez referentne strategije",
    "placeholder-range": "Equity protiv privremenih zadanih raspona (chartovi nemaju čvor za protivnikovu liniju)",
    "preflop-range": "Equity protiv preflop raspona iz chartova, nesuženih kasnijim betovima",
    antes: "Ante u potu",
    straddle: "Straddle je pomaknuo blindove, a nijedan skup chartova ne modelira ovaj",
    "stack-depth": "Stackovi izvan 100 bb ±20 %",
    "table-size": "Nije stol za šest igrača",
    model: "Preflop chartovi (od charts/2 do charts/4) još podcjenjuju nekoliko implied-odds ruku (UTG-ove male parove i suited konektore) i flat buttona protiv cutoff opena",
    "short-handed": "Manje igrača od mjesta u setu chartova, čitano uz foldane najranije pozicije",
    "stack-depth-near": "Stackovi unutar 20 % od dubine seta chartova, ali ne točno na njoj",
    "off-tree-size": "Raise daleko od veličine u chartovima: ocjena ograničena na Netočno",
    "out-of-range": "Tvoja ruka je izvan referentnog raspona u ovoj situaciji",
    "narrowing-heuristic": "Rasponi suženi heurističkim modelom na flopu (i na turnu gdje turn nije riješen), ne solverom",
    "rake-profile": "Riješeno s rakeom iz chartova (5 %, najviše 3 bb), ne s rakeom ove sobe",
    "size-translated": "Veličine betova pročitane kao najbliže solverove veličine",
    "solver-unconverged": "Rješavanje je stalo iznad cilja (0,5 % pota na riveru, 1 % na turnu) od ravnoteže",
    "range-cap": "Solverova ocjena ograničena na Grešku: heuristički suženi rasponi ne mogu nositi Grubu grešku",
    "range-sensitive": "Solverova ocjena ovisi o tome koliko se rasponi sužavaju: prikazana je blaža od dvije",
    "limp-tremble": "Limpani pot: chartovi tu sami gotovo ne limpaju, pa pretpostavljaju da limper može imati bilo koju ruku",
    "rare-line-depth":
      "Linija je na ovoj dubini stacka prerijetka da bi bila u chartovima, pa je očitana na najbližoj dubini koja je ima; ocjena nije gora od Netočno",
    "coarse-river": "Turn riješen s grubim riverom ispod njega: jedna veličina beta i all-in",
    "flop-mapped": "Flop očitan s najbližeg riješenog flopa iste teksture, a ne riješen sam",
    "library-bucketed": "Tvoja ruka očitana po kategoriji (gotova ruka i draw) u biblioteci flopova, a ne kombinacija po kombinacija",
    "multiway-approx":
      "Približna multiway ocjena: call na flopu, turnu ili riveru u odnosu na fold, po showdown EV-u na suženim rasponima; igrači na potezu callaju ili foldaju prema modelu, raise se ne uspoređuje; najviše Greška",
    "flop-realisation":
      "Flop: udio pota koji će ruka osvojiti je njezin equity puta faktor izmjeren na heads-up biblioteci flopova, po poziciji i kategoriji ruke; računa se samo gubitak EV-a veći od 5% pota",
    "turn-realisation":
      "Turn: udio pota koji će ruka osvojiti je njezin equity puta faktor izmjeren na Railovim vlastitim heads-up rješenjima turna, po poziciji i kategoriji ruke; računa se samo gubitak EV-a veći od 5% pota",
    "multiway-history": "Flop su vidjela tri ili više igrača: riješeno heads-up od trenutka kad je pot postao heads-up, na rasponima suženima kroz multiway streetove",
    "range-neighbour-depth":
      "Preflop raspon igrača očitan je iz chartova na najbližoj dubini stacka koja ima njegovu liniju, jer ga na ovoj dubini nijedan chart ne pokriva",
    "range-limp-call":
      "Igrač koji je limpao pa callao raise počinje od zadanog limp raspona: raspon callanja iz chartova tamo lošije odgovara rukama koje takvi igrači pokažu",
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
    "multiway-bluff": "Blef u više igrača",
    "multiway-slowplay": "Slowplay ranjive ruke u multiway potu",
    "multiway-dominated-draw": "Call stacka s drawom koji nije nuts, multiway",
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
    graded: "Ocijenjeno",
    evLoss: "Gubitak EV-a",
    score: "Bodovi",
    distribution: "Savršeno → Gruba greška",
  },

  breakdown: {
    heading: "Raščlamba",
    splitBy: "Podijeli po",
    groups: {
      street: "Streetu",
      position: "Poziciji",
      pot_type: "Vrsti pota",
      preflop_scenario: "Preflop situaciji",
      scenario: "Situaciji",
    } as Record<string, string>,
    gradesTitle: "Ocjene",
    flagsTitle: "Oznake i obrana",
    unknown: "Nepoznato",
    scenario: (key: string) => {
      if (preflopScenarios[key]) return preflopScenarios[key];
      const parts = key.split("-");
      const multiway = parts[1] === "mw";
      const [role, where, ...rest] = multiway ? [parts[0], ...parts.slice(2)] : parts;
      const facingKey = rest.join("-");
      const side = multiway ? (where === "ip" ? "multiway, zadnji" : "multiway") : where === "ip" ? "IP" : "OOP";
      return `${roles[role] ?? role}, ${side}, ${facing[facingKey] ?? facingKey}`;
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
    grade: "Ocjena",
    anyGrade: "Bilo koja",
    badGrades: "Greška ili gore",
    sort: "Poredak",
    sorts: {
      recent: "Najnovije prvo",
      oldest: "Najstarije prvo",
      flags: "Najviše oznaka",
      ev_loss: "Najveći gubitak EV-a (bb)",
      ev_loss_pot: "Najveći gubitak EV-a (% pota)",
      score: "Najmanje bodova",
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
    grade: "Ocjena",
    score: "Bodovi",
    evLoss: "Gubitak EV-a",
    evLossPot: "% pota",
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
    notGradedHint:
      "Ništa u ovoj ruci nije ocijenjeno: preflop chartovi ne pokrivaju ovu liniju, flop je samo bilješke, a na turnu i riveru nije bilo heads-up odluke koju solver može riješiti ni multiway calla ili folda na flopu, turnu ili riveru koji bi se procijenio.",
    evLoss: "Gubitak EV-a",
    evLossPot: (value: number) => `${pct(value)} pota`,
    score: "Bodovi",
    optionsHeading: "Referenca ovdje",
    colAction: "Akcija",
    colFreq: "Frekvencija",
    colEv: "EV",
    yourMove: "Tvoj potez",
    best: "Najbolje",
    better: (label: string) => `Bolje: ${label}`,
    option: (action: string, sizeBb: number | undefined, allIn: boolean | undefined, sizePot?: number) =>
      allIn
        ? "All-in"
        : action === "raise" || action === "bet"
          ? sizeBb !== undefined
            ? `${action === "bet" ? "Bet" : "Raise na"} ${bb(sizeBb)}${action === "bet" && sizePot !== undefined ? ` (${pct(sizePot)})` : ""}`
            : action === "bet"
              ? "Bet"
              : "Raise"
          : ({ fold: "Fold", check: "Check", call: "Call" } as Record<string, string>)[action] ?? action,
    signedBb,
    freq: pct1,
    source: {
      chart: "Ocijenjeno prema preflop chartovima",
      heuristic: "Samo heurističke provjere — bez ocjene",
      solver: "Ocijenjeno prema solveru",
      approx: "Približno (multiway): call u odnosu na fold po EV-u na suženim rasponima",
    } as Record<string, string>,
    optionsHeadingApprox: "Približni EV protiv suženih raspona",
    approxMark: "(približno)",
    approxNote: "Najbolji odgovor, ne riješena mješavina: bolja od dviju opcija prikazana je sa 100 %. Raise se ne uspoređuje.",
    study: "Prouči chart",
    hideStudy: "Sakrij chart",
    openBrowser: "Otvori u pregledniku chartova",
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
      players: "Igrači",
      vsEach: "Equity protiv svakog",
      field: "Equity protiv polja",
      mdfSplit: "Podjela MDF-a",
      foldEquity: "Svi foldaju",
      outs: "Sljedeća karta",
    },
    playersValue: (players: number, behind: number) =>
      behind === 0 ? `${num(players)} igrača, ti si zadnji` : `${num(players)} igrača, iza tebe ${opponentsNom(behind)}`,
    vsEachValue: (rows: Array<{ equity: number; range: string }>) => rows.map((r) => `${pct(r.equity)} protiv ${rangeLabel(r.range)}`).join(" · "),
    mdfSplitValue: (mdf: number, defenders: number, each: number) => `${pct(mdf)} za stol · ${pct(each)} svaki od ${num(defenders)}`,
    foldEquityValue: (all: number, needed: number) => `oko ${pct(all)} (bet treba ${pct(needed)})`,
    outsValue: (nut: number, nonNut: number, cards: number) => `${num(nut)} od ${num(cards)} daju nuts · ${num(nonNut)} skalu ili jače koje nije nuts`,
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

  river: {
    study: "Prouči river",
    hideStudy: "Sakrij proučavanje",
    loading: "Rješavam river…",
    failed: (message: string) => `Proučavanje rivera nije se učitalo: ${message}`,
    unavailable: "Solver nije mogao ponovno složiti ovu situaciju.",
    heading: "Tvoj raspon ovdje, kako ga solver igra",
    note: "Rješenje iza ocjene, ponovno pokrenuto u tvojem pregledniku: svaka ruka tvojeg raspona u ovoj odluci i što solver s njom radi.",
    gridLabel: (spot: string) => `${spot}: solverov miks za tvoj raspon, po rukama`,
    spot: (path: string) => (path ? `River nakon ${path.split("-").join(", ")}` : "River, prva odluka"),
    cellLabel: (hand: string, combos: number, parts: string[]) =>
      combos > 0 ? `${hand}, ${num(combos, combos < 10 ? 1 : 0)} kombinacija: ${parts.join(", ")}` : `${hand}: nije u tvojem rasponu ovdje`,
    part: (label: string, freq: number) => `${label} ${pct1(freq)}`,
    totals: (label: string, share: number, value: number) =>
      `${label} ${pct1(share)} · ${num(Math.round(value * 10) / 10, value < 10 ? 1 : 0)} kombinacija`,
    detailEmpty: "Prijeđi mišem preko ruke ili je fokusiraj da vidiš njezin miks i koliko svaka akcija vrijedi.",
    detailCombos: (value: number) => `${num(value, value < 10 ? 1 : 0)} ponderiranih kombinacija u tvojem rasponu ovdje.`,
    notInRange: "Nije u tvojem rasponu u ovoj točki.",
    yourHand: "Tvoja ruka",
    yourCombo: (combo: string) => `Tvoja ruka (${combo})`,
    categoriesTitle: "Po rukama",
    strengthTitle: "Po snazi protiv protivnikova raspona ovdje",
    colHand: "Ruke",
    colCombos: "Kombinacije",
    colMix: "Solverov miks",
    groups: { made: "Složene ruke", missed: "Promašeni drawovi", nothing: "Bez složene ruke" } as Record<string, string>,
    categories: {
      "full-house-plus": "Full house ili jače",
      flush: "Boja",
      straight: "Skala",
      "set-trips": "Set ili tris",
      "two-pair": "Dva para",
      "top-pair": "Top par ili overpar",
      "middle-pair": "Drugi par ili džepni par ispod najviše karte",
      "weak-pair": "Slab par ili underpar",
      "missed-flush-draw": "Promašen flush draw",
      "missed-straight-draw": "Promašen straight draw",
      "ace-high": "As kao najviša karta",
      "no-pair": "Bez para",
    } as Record<string, string>,
    strength: {
      strong: "Value: pobjeđuje 75 % ili više",
      medium: "Bluff-catcheri: pobjeđuju 25–75 %",
      weak: "Zrak: pobjeđuje manje od 25 %",
    } as Record<string, string>,
    villainTitle: "Protivnikov raspon ovdje",
    villainSummary: (value: number, strong: number, medium: number, weak: number) =>
      `${num(Math.round(value * 10) / 10, value < 10 ? 1 : 0)} ponderiranih kombinacija, bez tvojih karata: ${pct(strong)} pobjeđuje većinu tvojeg raspona, ${pct(medium)} je u sredini, ${pct(weak)} pobjeđuje malo toga.`,
    share: pct1,
    combos: (value: number) => num(Math.round(value * 10) / 10, value < 10 ? 1 : 0),
    mixLabel: (parts: string[]) => parts.join(", "),
    solved: (iterations: number, exploitability: number) =>
      `Riješeno u ${num(iterations)} iteracija do ${num(exploitability, 2)} % pota od ravnoteže. Rasponi suženi heurističkim modelom prije rivera; veličine 33 / 75 / 150 % pota i all-in.`,
    evNote: "EV u big blindovima, neto od početka rivera, s potom koji se može osvojiti.",
    signedBb,
    freq: pct1,
  },

  turn: {
    study: "Prouči turn",
    loading: "Rješavam turn…",
    failed: (message: string) => `Proučavanje turna nije se učitalo: ${message}`,
    gridLabel: (spot: string) => `${spot}: solverov miks za tvoj raspon, po rukama`,
    spot: (path: string) => (path ? `Turn nakon ${path.split("-").join(", ")}` : "Turn, prva odluka"),
    groups: { made: "Složene ruke", draws: "Drawovi", nothing: "Bez složene ruke i drawa" } as Record<string, string>,
    categories: {
      "full-house-plus": "Full house ili jače",
      flush: "Boja",
      straight: "Skala",
      "set-trips": "Set ili tris",
      "two-pair": "Dva para",
      "top-pair": "Top par ili overpar",
      "middle-pair": "Drugi par ili džepni par ispod najviše karte",
      "weak-pair": "Slab par ili underpar",
      "combo-draw": "Flush draw sa straight drawom",
      "flush-draw": "Flush draw",
      "straight-draw": "Otvoreni straight draw",
      gutshot: "Gutshot",
      "ace-high": "As kao najviša karta",
      "no-pair": "Bez para",
    } as Record<string, string>,
    strengthTitle: "Po trenutačnoj snazi protiv protivnikova raspona ovdje",
    strength: {
      strong: "Ispred: sada pobjeđuje 75 % ili više",
      medium: "Sredina: sada pobjeđuje 25–75 %",
      weak: "Iza: sada pobjeđuje manje od 25 %",
    } as Record<string, string>,
    solved: (iterations: number, exploitability: number) =>
      `Riješeno kroz river u ${num(iterations)} iteracija do ${num(exploitability, 2)} % pota od ravnoteže. Rasponi suženi heurističkim modelom na flopu; turn veličine 75 % pota i all-in (raise 75 % i all-in) uz svaku veličinu iz ove ruke; ispod njega grubi river, 75 % i all-in.`,
    evNote: "EV u big blindovima, neto od početka turna, s potom koji se može osvojiti.",
  },

  charts: {
    heading: "Preflop chartovi",
    intro:
      "Railova vlastita referenca za No-Limit Hold'em cash — šest igrača od 40 do 200 big blindova duboko, puni stol od 100 do 200 — izračunata našim solverom, nikad prepisana iz tuđih chartova. Odaberi stol i situaciju: svaka ruka pokazuje koliko često referenca igra svaku akciju, a kad prijeđeš mišem preko ruke ili je fokusiraš, vidiš koliko svaka akcija vrijedi.",
    caveatTitle: "Model, s poznatom slabošću",
    caveat:
      "Ovi chartovi (charts/4) vrijednost flopa računaju modelom realizacije equityja prilagođenim našem postflop solveru. Mjerenje checka flop, pa su ruke koje dobivaju kroz implied odds još malo podcijenjene: UTG folda 55–22, 87s–54s i A5s, a button gotovo nikad ne flata cutoff open. Ocjene protiv igranja takvih ruku su stroge. Limpani potovi su uključeni: referenca sama rijetko limpa izvan small blinda, pa iza limpa pretpostavlja da limper može imati bilo koju ruku.",
    loading: "Učitavam chartove…",
    failed: (message: string) => `Chartovi se nisu učitali: ${message}`,
    table: "Stol i dubina",
    setOption: (players: number, stackBb: number, straddle = false) => `${players}-max, ${stackBb} bb${straddle ? ", straddle" : ""}`,
    category: "Scenarij",
    spot: "Situacija",
    categories: {
      rfi: "Otvaranje (RFI)",
      "vs-open": "Protiv otvaranja",
      "vs-3bet": "Protiv 3-beta",
      "vs-4bet": "Protiv 4-beta ili all-ina",
      squeeze: "Squeeze",
      bvb: "Blind protiv blinda",
      "vs-limp": "Pot s limperima",
    } as Record<string, string>,
    verbs: {
      open: "otvori",
      iso: "izolira",
      limp: "limpa",
      call: "calla",
      "3bet": "3-beta",
      "4bet": "4-beta",
      "5bet": "5-beta",
      allin: "ide all-in",
      check: "checka",
    } as Record<string, string>,
    spotLabel: (actor: string, steps: Array<{ position: string; verb: string }>) =>
      steps.length === 0 ? `${actor}, prvi u potu` : `${actor}, nakon što ${list(steps.map((s) => `${s.position} ${s.verb}`))}`,
    action: (action: string, toBb: number) =>
      action === "raise"
        ? `Raise na ${bb(toBb)}`
        : action === "call" && toBb === 1
          ? "Limp"
          : (({ fold: "Fold", check: "Check", call: "Call", allin: "All-in" }) as Record<string, string>)[action] ?? action,
    legend: "Akcije",
    totals: "Cijeli raspon",
    total: (label: string, share: number, count: number) => `${label} ${pct1(share)} · ${combos(Math.round(count))}`,
    gridLabel: (spot: string) => `${spot}: mix reference za svih 169 ruku`,
    cellLabel: (hand: string, parts: string[], offRange: boolean) =>
      `${hand}: ${parts.join(", ")}${offRange ? " (nikad ne dolazi u ovu situaciju)" : ""}`,
    part: (label: string, freq: number) => `${label} ${pct1(freq)}`,
    detailEmpty: "Prijeđi mišem preko ruke ili je fokusiraj da vidiš njezin mix i koliko svaka akcija vrijedi.",
    reaches: (share: number) => `U ovu situaciju dolazi s ${pct1(share)} svojih kombinacija.`,
    offRange: "Referenca ovdje nikad ne dolazi s ovom rukom; prikazan je najbolji odgovor.",
    yourHand: "Tvoja ruka",
    pot: (pot: number, toCall: number) => (toCall > 0 ? `Pot ${bb(pot)}, za call ${bb(toCall)}` : `Pot ${bb(pot)}`),
    evNote: "EV u big blindovima, neto od početka ruke: fold vrijedi minus ono što je već uloženo.",
    set: (id: string, version: string) => `${id} · ${version}`,
    signedBb,
    freq: pct1,
  },

  reports: reportsHr,

  leaks: leaksHr,
  progress: progressHr,
  summary: summaryHr,

  train: trainHr,

  share: shareHr,
  plan: planHr,

  explain,
};
