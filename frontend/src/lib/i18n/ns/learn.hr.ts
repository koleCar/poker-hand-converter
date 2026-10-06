import { plural } from "../plural";
import type { Dict } from "../types";

/**
 * Strings for the concept library (`/analysis/learn`), Croatian. Same shape as
 * `learn.en.ts`; see its header for what lives here and what does not.
 *
 * Poker words stay the ones Croatian players use (pot odds, equity, range kao
 * "raspon", c-bet, check-raise, SPR, MDF), the sentences around them are
 * Croatian, addressed with "ti".
 */

const titles = {
  "pot-odds": "Pot odds",
  "equity-realisation": "Equity i realizacija equityja",
  "ev-and-grading": "EV, gubitak EV-a i kako Rail ocjenjuje",
  "gto-vs-exploitative": "GTO i eksploatativna igra",
  position: "Pozicija",
  ranges: "Rasponi",
  "range-advantage": "Prednost raspona",
  "nut-advantage": "Prednost u nutsu",
  "board-texture": "Tekstura boarda",
  "dynamic-boards": "Dinamični i statični boardovi",
  blockers: "Blockeri i unblockeri",
  spr: "SPR i vezanost uz pot",
  "mdf-alpha": "MDF i alpha",
  "bet-sizing": "Veličina beta i polarizacija",
  "continuation-bet": "Continuation bet",
  "check-raise": "Check-raise",
  "donk-bet": "Donk bet",
  "bluff-catching": "Hvatanje blefova",
  "thin-value": "Tanki value bet",
  "multiway-pots": "Multiway potovi",
  rfi: "Prvi raise (RFI)",
  "three-bet": "3-betovi i 4-betovi",
  squeeze: "Squeeze",
  "blind-defence": "Obrana blindova",
  steal: "Krađa blindova (steal)",
} as Record<string, string>;

export const learnHr: Dict["learn"] = {
  nav: {
    label: "Dijelovi analize",
    overview: "Tvoja analiza",
    train: "Vježbaj",
    plan: "Plan učenja",
    leaks: "Leakovi",
    progress: "Napredak",
    reports: "Izvještaji",
    charts: "Chartovi",
    learn: "Pojmovi",
    more: "Više",
  },

  titles,

  index: {
    heading: "Pojmovi",
    intro:
      "Ideje iza svakog objašnjenja u tvojoj analizi: što znače, matematika gdje je ima, razrađen primjer i nešto za isprobati. Svaka poveznica u objašnjenju vodi na jednu od ovih stranica.",
    groups: {
      foundations: "Osnove",
      ranges: "Rasponi i boardovi",
      betting: "Betanje",
      preflop: "Preflop",
    } as Record<string, string>,
    interactive: "Interaktivno",
  },

  page: {
    breadcrumb: "Pojmovi",
    backToIndex: "Svi pojmovi",
    definition: "Što je to",
    why: "Zašto je važno",
    formulas: "Matematika",
    where: "Pri čemu je",
    example: "Razrađen primjer",
    mistakes: "Česte greške",
    tryIt: "Isprobaj",
    related: "Povezani pojmovi",
    yourHands: "U tvojim rukama",
    yourHandsBody: "Ruke iz tvoje biblioteke u kojima je analiza ovo označila:",
    handsWithFlag: (flag: string) => `Ruke s oznakom „${flag}”`,
    yourHandsNote: "Otvara tvoju analizu, filtriranu. Moraš biti prijavljen/a; tvoje ruke ne vidi nitko drugi.",
  },

  learnLabel: "Nauči",
  learnLink: (title: string) => `Nauči: ${title}`,

  widgets: {
    illustrative: "Ilustrativni rasponi, napisani ručno za učenje — nisu izračunati solverom.",
    pot: "Pot",
    potIncludingBet: "Pot, uključujući bet protiv kojeg igraš",
    potBeforeBet: "Pot prije beta",
    potBeforeRaise: "Pot prije tvojeg raisea",
    blinds: "Blindovi i ante u sredini",
    toCall: "Za call",
    bet: "Bet",
    raise: "Tvoj bet ili raise",
    open: "Tvoj open (uloženi čipovi)",
    yourEquity: "Tvoj equity",
    foldRate: "Koliko često foldaju",
    bb: (value: string) => `${value} bb`,
    ofPot: (value: string) => `${value} pota`,
    ratio: (value: string) => `${value} prema 1`,

    requiredEquity: "Potreban equity",
    potOdds: "Pot odds",
    callEv: "EV calla",
    alpha: "Alpha: potrebni foldovi",
    mdf: "MDF: brani barem",
    callerPrice: "Calleru treba",
    bluffShare: "Blefovi u polariziranom betu",
    valuePerBluff: "Value ruku po blefu",
    bluffEv: "EV ako nikad ne pobijedi kad je callan",
    evPositive: "Isplativo",
    evNegative: "Gubitno",
    evZero: "Na nuli",

    sizingTable: {
      caption: "Uobičajene veličine beta, uz pot prije beta kao 100 %. Ono što calleru treba ujedno je i udio blefova u polariziranom betu.",
      size: "Bet",
      alpha: "Alpha",
      mdf: "MDF",
      price: "Calleru treba",
    },

    spr: {
      stack: "Efektivni stack",
      streets: "Streetovi za betanje",
      spr: "SPR",
      geometric: "Geometrijski bet na svakom streetu",
      potBets: "Callanih pot betova koje stackovi podnose",
      streetCount: (count: number) => `${count} ${plural(count, "street", "streeta", "streetova")}`,
    },

    cards: {
      board: "Board",
      hand: "Tvoja ruka",
      pickBoard: "Odaberi 3 do 5 karata boarda",
      pickHand: "Odaberi svoje dvije karte",
      clear: "Očisti",
      random: "Nasumični flop",
      presets: "Primjeri",
      suitRow: (suit: string) => `${suit}`,
      selected: (cards: string) => (cards ? `Odabrano: ${cards}` : "Ništa nije odabrano"),
      noBoard: "Bez boarda (preflop)",
    },

    texture: {
      needCards: "Odaberi barem tri karte da pročitaš board.",
      paired: "Uparen",
      trips: "Tris na boardu",
      unpaired: "Neuparen",
      suits: { rainbow: "Rainbow", "two-tone": "Dvobojan", monotone: "Jednobojan" } as Record<string, string>,
      connectedness: {
        disconnected: "Nepovezan",
        "semi-connected": "Djelomično povezan",
        connected: "Povezan",
      } as Record<string, string>,
      highCard: { ace: "S asom", broadway: "Visok (broadway)", middle: "Srednji", low: "Nizak" } as Record<string, string>,
      dynamism: { static: "Statičan", medium: "Umjereno dinamičan", dynamic: "Dinamičan" } as Record<string, string>,
      straightCombos: "Skale s dvije karte",
      flushPossible: "Moguć flush",
      straightPossible: "Moguća skala",
      yes: "Da",
      no: "Ne",
      volatility: "Volatilnost",
      volatilityHint: "Udio sljedećih karata koje mijenjaju board (overkarte se broje upola)",
      river: "River: nema sljedeće karte, pa nije ni statičan ni dinamičan.",
      thresholds: "Statičan ispod 25 %, dinamičan od 45 %",
    },

    equity: {
      range: "Protivnikov raspon",
      ranges: {
        "open-utg": "UTG open",
        "open-btn": "Open s buttona",
        "call-bb": "Call iz big blinda",
        "call-bb-vs-utg": "Call iz big blinda protiv UTG-a",
        "3bet": "3-bet",
        "call-3bet": "Call na 3-bet",
        "4bet": "4-bet",
      } as Record<string, string>,
      raw: "Sirovi equity",
      realisation: "Realizacija",
      realised: "Realizirani equity",
      combos: (count: number, formatted: string) =>
        `${formatted} ${plural(count, "kombinacija", "kombinacije", "kombinacija")} u rasponu nakon uklanjanja karata`,
      priceLabel: "Cijena za usporedbu",
      needHand: "Odaberi dvije karte za svoju ruku.",
      emptyRange: "Nakon uklanjanja karata u tom rasponu ne ostaje nijedna kombinacija.",
      sampled: "Procijenjeno uzorkovanjem s fiksnim seedom",
    },

    rvr: {
      matchup: "Okršaj",
      matchups: {
        "btn-vs-bb": "Open s buttona protiv calla iz big blinda",
        "utg-vs-bb": "UTG open protiv calla iz big blinda",
        "3bet-vs-call": "3-bet protiv calla",
      } as Record<string, string>,
      raiser: "Raiser",
      caller: "Caller",
      equity: "Equity raspona",
      nuts: "U najjačih 10 % ruku",
      needFlop: "Odaberi flop (ili primjer) da usporediš raspone na boardu.",
    },

    combos: {
      preset: "Njihov raspon",
      presets: {
        premium: "QQ+ i AK",
        broadway: "AK, AQ, KQ",
        "wheel-aces": "A5s–A2s",
        "sets-k72": "KK, 77, 22",
      } as Record<string, string>,
      class: "Ruka",
      total: "Kombinacije",
      left: "Preostalo",
      sum: "Ukupno",
      removed: (share: string) => `Tvoje karte i board uklanjaju ${share} ovih kombinacija.`,
    },

    grading: {
      pot: "Pot prije odluke",
      option: "Opcija",
      freq: "Referentna frekvencija",
      ev: "EV (bb)",
      chosen: "Odigrao/la si",
      fold: "Fold",
      call: "Call",
      raise: "Raise",
      foldRest: "Fold dobiva ostatak",
      grade: "Ocjena",
      evLoss: "Gubitak EV-a",
      evLossPot: "pota",
      score: "Rezultat",
      evLabel: (option: string) => `EV opcije ${option} u bb`,
      freqLabel: (option: string) => `Referentna frekvencija opcije ${option}`,
    },

    bluffCatcher: {
      bluffs: "Njihov udio blefova",
      indifferent: "Indiferentno pri",
      ev: "EV calla",
      verdict: { call: "Call", fold: "Fold", either: "Svejedno" } as Record<string, string>,
    },

    valueBet: {
      callRate: "Koliko često callaju",
      beatShare: "Udio callova koje pobjeđuješ",
      gain: "Dobitak u odnosu na check",
      verdict: { bet: "Bet", check: "Check", either: "Svejedno" } as Record<string, string>,
    },
    multiway: {
      opponents: "Protivnici u koje ide bet",
      opponentCount: (count: number) => (count === 1 ? "1 protivnik" : `${count} protivnika`),
      foldEach: "Koliko često svaki folda",
      allFold: "Svi foldaju",
      needed: "Foldovi koje bet treba (alfa)",
      bluffEv: "EV čistog blefa",
      mdfHeadsUp: "Obrana heads-up (MDF)",
      mdfEach: "Svaki branitelj treba nastaviti",
      verdict: { bet: "Isplativ blef", check: "Gubitan blef", either: "Na nuli" } as Record<string, string>,
    },
  },
};
