import { plural } from "../plural";

/**
 * Strings for the Analysis tab's Reports (`/analysis/reports`, phase A3),
 * Croatian. Same shape as `analysisReports.en.ts`. Poker words stay the ones
 * Croatian players use (fold, call, raise, 3-bet, open, steal, squeeze,
 * c-bet); the sentences around them are Croatian, addressed with "ti".
 */

const num = (value: number, digits = 0) =>
  value.toLocaleString("hr-HR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
/** Genitiv iza "u": u 1 ruci, u 2 ruke, u 5 ruku. */
const handsLoc = (count: number) => `${num(count)} ${plural(count, "ruci", "ruke", "ruku")}`;
/** 1 odluka, 2 odluke, 5 odluka. */
const decisions = (count: number) => `${num(count)} ${plural(count, "odluka", "odluke", "odluka")}`;
const pct = (value: number) => {
  const p = value * 100;
  return p > 0 && p < 10 ? `${num(Math.round(p * 10) / 10, 1)} %` : `${num(Math.round(p))} %`;
};
/** Razlika u postotnim bodovima: "+6,4 p. b.", "−12 p. b.". */
const points = (value: number) => {
  const p = Math.round(value * 1000) / 10;
  const sign = p > 0 ? "+" : p < 0 ? "−" : "±";
  const abs = Math.abs(p);
  return `${sign}${num(abs, abs > 0 && abs < 10 ? 1 : 0)} p. b.`;
};
const bb = (value: number) => `${num(value, 2)} bb`;

const actions = { fold: "Fold", check: "Check", call: "Call", raise: "Raise", allin: "All-in" } as Record<string, string>;

export const reportsHr = {
  heading: "Izvještaji",
  intro:
    "Koliko često igraš svaku akciju u preflop situacijama koje chartovi pokrivaju, uz to koliko često je igra referenca — i ruke u kojima si od nje odstupio, najskuplje prve.",
  loading: "Čitam tvoje odluke…",
  loadingCharts: "Učitavam chartove…",
  chartsFailed: (message: string) => `Chartovi se nisu učitali: ${message}`,
  notInstalledHeading: "Izvještaji još nisu postavljeni na ovoj bazi",
  notInstalledBefore: "Stižu s migracijom ",
  notInstalledAfter: ". Primijeni je i ponovno učitaj stranicu.",
  emptyHeading: "Još ništa nije ocijenjeno",
  emptyBody:
    "Izvještaji uspoređuju tvoje ocijenjene preflop odluke s chartovima. Najprije pokreni analizu svojih ruku; ona ocjenjuje svaku odluku koju chartovi pokrivaju.",
  goToAnalysis: "Idi na svoju analizu",
  noneInScope: "Nijedna ocijenjena preflop odluka ne odgovara ovim filtrima.",
  sample: (count: number, handCount: number) => `Ocijenjenih odluka: ${num(count)}, u ${handsLoc(handCount)}`,
  unmatched: (count: number) =>
    `Odluka ocijenjenih u situacijama kojih ovaj set chartova više nema: ${num(count)}. Izostavljene su dok ponovno ne pokreneš analizu.`,

  filters: {
    ariaLabel: "Filtri izvještaja",
    from: "Od",
    to: "Do",
    room: "Soba",
    anyRoom: "Sve sobe",
    stake: "Ulozi",
    anyStake: "Svi ulozi",
    stakeOption: (label: string, count: number) => `${label} (${num(count)})`,
    unknownStake: "Nepoznati ulozi",
    position: "Pozicija",
    anyPosition: "Sve pozicije",
    clear: "Očisti filtre",
  },

  how: {
    toggle: "Kako ovo čitati",
    title: "Dvije reference, i kada razlika nešto znači",
    range:
      "Referenca: koliko često chartovi igraju akciju preko cijelog raspona koji dolazi do situacije — svaka ruka ponderirana brojem kombinacija i time koliko često referenca s njom dođe ovdje. Ruka koju držiš mijenja koliko su vjerojatne akcije igrača prije tebe (opener drži više aseva), pa je svaka ruka ponderirana i rasponima protivnika, kartu po kartu; to je model samih chartova, s protivnicima međusobno neovisnima.",
    adjusted:
      "Tvoje ruke: što chartovi rade s rukama koje si stvarno držao u toj situaciji, prosječno po tvojim odlukama. Tvoje ruke nisu podijeljene iz raspona reference — do 3-beta dolaziš sa svojim opening rasponom — a na nekoliko desetaka ruku čak i savršenom igraču frekvencija odluta od raspona zbog sreće u dijeljenju. Ovaj stupac nema nijedan od ta dva problema: ako svaku ruku odigraš kao chart, jednak je tvojem.",
    verdict:
      "U redu: referenca je unutar 95 % intervala tvoje frekvencije ili je razlika manja od 2 boda. Odstupa: izvan je, i to za više. Premalo: manje od 10 odluka, gdje je moguća bilo koja frekvencija.",
    sample:
      "Svaka statistika zbraja situacije. Njezina referenca svaku situaciju ponderira tvojim odlukama u njoj, pa se tvoj RFI uspoređuje s RFI-jem chartova za pozicije s kojih si stvarno otvarao.",
    mixed:
      "Ruka koju referenca igra na dva načina na popisu ruku je Savršena u oba slučaja; tek ovdje, kroz mnogo ruku, vidi se ako uvijek biraš istu stranu.",
    model:
      "Referenca su Railovi vlastiti chartovi (charts/4: 6-max i full ring, od 40 do 200 bb, s limpanim potovima), svaka odluka prema skupu koji ju je ocijenio. I dalje malo podcjenjuju ruke koje dobivaju kroz implied odds, pa male parove i suited connectore callaju i otvaraju rjeđe od većine igrača. U limpanom potu limper u referenci može imati bilo koju ruku.",
  },

  columns: {
    stat: "Statistika",
    spot: "Situacija",
    split: "Pozicija",
    decisions: "Odluke",
    yours: "Ti",
    reference: "Referenca",
    adjusted: "Tvoje ruke",
    diff: "Razlika",
    verdict: "Ocjena",
    action: "Akcija",
    whatIsAdjusted: "Što znače dvije reference?",
  },

  verdicts: { "in-line": "U redu", deviates: "Odstupa", "too-few": "Premalo" } as Record<string, string>,
  interval: (low: number, high: number) => `95 %: ${pct(low)}–${pct(high)}`,
  pct,
  points,
  bb,
  actions,
  splitLabel: (position: string, versus: string | null) => (versus ? `${position} protiv ${versus}` : position),
  expand: (name: string) => `Prikaži pojedinosti: ${name}`,
  collapse: (name: string) => `Sakrij pojedinosti: ${name}`,
  summary: (yours: string, reference: string, verdict: string) => `Ti ${yours}, referenca ${reference}: ${verdict}`,
  noDecisions: "Još nema odluka",

  /** Filtar skupa charta (A2d). */
  sets: {
    label: "Charti",
    all: (count: number) => `Svi stolovi i dubine (${num(count)})`,
    option: (name: string, decisions: string) => `${name} · ${decisions}`,
    note: "Svaka se odluka uspoređuje sa skupom charta koji ju je ocijenio; statistika preko više skupova važe referencu svakog skupa tvojim odlukama u njemu.",
    tableTag: (label: string, table: number) => `${label} · ${table}-max`,
    nodeTag: (spot: string, set: string) => `${spot} (${set})`,
  },

  stats: {
    heading: "Tvoje statistike prema referenci",
    note: "Poznate preflop statistike, zbrojene iz chart situacija iza njih. Otvori redak za pozicije i ruke u kojima si odstupio od reference.",
    bySplit: "Po poziciji",
    names: {
      rfi: "Raise first in",
      steal: "Steal",
      "three-bet": "3-bet na open",
      "blind-defence": "Obrana blindova",
      "fold-to-steal": "Fold na steal",
      "fold-to-three-bet-ip": "Fold na 3-bet, u poziciji",
      "fold-to-three-bet-oop": "Fold na 3-bet, izvan pozicije",
      "four-bet": "4-bet",
      squeeze: "Squeeze",
      iso: "Izolacijski raise",
    } as Record<string, string>,
    definitions: {
      rfi: "Svi prije tebe su foldali, a ti si raiseao. Limp malog blinda nije open.",
      steal: "Open s cutoffa, buttona ili malog blinda, kad su iza samo blindovi.",
      "three-bet": "Reraiseao si jedan open koji nitko nije callao. S callerima između to je squeeze.",
      "blind-defence": "U blindu protiv jednog opena callao si ili 3-betao umjesto da foldaš.",
      "fold-to-steal": "U blindu protiv opena s cutoffa, buttona ili malog blinda foldao si.",
      "fold-to-three-bet-ip": "Otvorio si, 3-betao te igrač iza kojeg igraš na flopu, i foldao si.",
      "fold-to-three-bet-oop": "Otvorio si, 3-betao te igrač koji na flopu igra iza tebe, i foldao si.",
      "four-bet": "Reraiseao si 3-bet — kao opener, caller ili hladno.",
      squeeze: "Reraiseao si open koji je callao jedan ili više igrača.",
      iso: "Raiseao si preko jednog ili više limpera, a da nitko nije raiseao (limperi u referenci mogu imati bilo koju ruku: limp je modeliran kao greška koju svatko može napraviti).",
    } as Record<string, string>,
    tips: {
      rfi: "Širina bi trebala rasti od pozicije do pozicije prema buttonu. Razlika na jednoj poziciji obično je nekoliko klasa ruku — otvori redak te pozicije i pročitaj ruke.",
      steal: "Blindovi protiv kasnog opena brane široko, ali izvan pozicije. Ako ovdje prečesto foldaš, poklanjaš im blindove.",
      "three-bet": "Protiv kasnog opena 3-betaš više, i s više blefova koji blokiraju ruke s kojima opener nastavlja.",
      "blind-defence": "Veliki blind zatvara akciju i dobiva cijenu; većina obrane ondje je call. Mali blind, izvan pozicije protiv svih, uglavnom 3-beta ili folda.",
      "fold-to-steal": "Iznad reference plaćaš blindove svaku rundu; daleko ispod nje braniš ruke koje gube više od blinda.",
      "fold-to-three-bet-ip": "U poziciji možeš callati šire: nakon flopa realiziraš više equityja.",
      "fold-to-three-bet-oop": "Callovi izvan pozicije realiziraju manje; foldaj više ili 4-betaj vrh i nekoliko blokera.",
      "four-bet": "4-betovi su uglavnom vrh raspona i nekoliko blokera (as) koji ne callaju dobro.",
      squeeze: "Calleri ograničavaju svoje raspone; squeezeaj veće od 3-beta i s rukama koje se dobro igraju kao raise.",
      iso: "Limperi su slabi i široki: izoliraj češće u poziciji i s kasnijih pozicija, veće s više limpera, a overlimpaj ruke kojima odgovara jeftin flop s više igrača.",
    } as Record<string, string>,
  },

  defence: {
    heading: "Obrana blindova protiv svakog openera",
    note: "Iz malog i velikog blinda protiv jednog opena: koliko često foldaš, callaš i 3-betaš. U svakoj ćeliji je tvoja frekvencija, a ispod nje referentna.",
    fold: "Fold",
    call: "Call",
    threeBet: "3-bet",
    cell: (yours: string, reference: string) => `${yours} · ${reference}`,
    cellLabel: (action: string, yours: string, reference: string, verdict: string) =>
      `${action}: ti ${yours}, referenca ${reference}, ${verdict}`,
  },

  nodes: {
    heading: "Situacija po situacija",
    note: "Svaka chart situacija u kojoj imaš ocijenjene odluke, najviše odluka prvo. Otvori je za svaku akciju prema obje reference i ruke u kojima si odstupio.",
    category: "Scenarij",
    allCategories: "Svi scenariji",
    showAll: (count: number) => `Prikaži svih ${num(count)} situacija`,
    showFewer: "Prikaži manje",
    decisions,
    widest: (action: string, yours: string, reference: string) => `${action} ${yours} · referenca ${reference}`,
    study: "Prouči ovu situaciju u chartovima",
    noneInCategory: "Nema ocijenjenih odluka u ovom scenariju.",
  },

  hands: {
    heading: "Gdje si odstupio od reference",
    note: "Odluke ocijenjene lošije od Savršene, najveći gubitak EV-a prvo.",
    loading: "Učitavam ruke…",
    empty: "Nema ih — svaka ocijenjena odluka ovdje bila je Savršena.",
    more: "Prikaži još",
    total: (count: number) => `${decisions(count)}`,
    open: (cards: string) => `Otvori analizu ruke ${cards}`,
    took: (action: string) => `Ti: ${action}`,
    better: (action: string, freq: string) => `Referenca: ${action} ${freq}`,
    evLoss: (value: number) => `−${bb(value)}`,
    failed: (message: string) => `Ruke se nisu učitale: ${message}`,
  },

  postflop: {
    heading: "Nakon flopa, po ulozi",
    note: "Tvoje vlastite frekvencije u heads-up potovima, prema tome jesi li preflop raiseao ili callao i igraš li zadnji na flopu. Limpani i multiway potovi su izostavljeni.",
    placeholder:
      "Još nema reference: postflop frekvencije trebaju riješen flop za svaki board, a to stiže s bibliotekom flopova (faza A5). Do tada su ovo tvoji brojevi, za praćenje kroz vrijeme.",
    streets: { flop: "Flop", turn: "Turn", river: "River" } as Record<string, string>,
    streetLabel: "Ulica",
    role: "Uloga",
    roles: {
      "pfr-ip": "Preflop raiser, u poziciji",
      "pfr-oop": "Preflop raiser, izvan pozicije",
      "caller-ip": "Preflop caller, u poziciji",
      "caller-oop": "Preflop caller, izvan pozicije",
    } as Record<string, string>,
    betFirst: "Bet kad si prvi ili kad ti checkaju",
    betFirstHint: { pfr: "c-bet", callerIp: "stab", callerOop: "donk bet" },
    foldVsBet: "Fold na bet",
    callVsBet: "Call na bet",
    raiseVsBet: "Raise na bet",
    of: (count: number) => `od ${num(count)}`,
    empty: "U uzorku nema heads-up odluka na ovoj ulici.",
  },
};
