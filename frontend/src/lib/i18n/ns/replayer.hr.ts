/**
 * Strings for the replayer components, Croatian. Same shape as `replayer.en.ts`.
 *
 * `plural` comes from `hr.ts`, which imports this file: a cycle, and a safe
 * one, because `plural` is a hoisted function declaration that is only ever
 * called from inside the functions below, never while the module evaluates.
 */

import type { Amount, PhfAction } from "../../phf/types";
import { plural } from "../plural";
import type { Dict } from "../types";

const num = (value: number) => value.toLocaleString("hr-HR");

/**
 * The frames keep the canonical pile names (`Pot`, `Main`, `Side`, `Side 2`,
 * or the room's own `side pot-1`); this is the Croatian label for one. A name
 * nobody has seen before is shown as the room printed it.
 */
function readPot(name: string): { kind: "pot" | "main" | "side" | null; number: string } {
  const key = name
    .toLowerCase()
    .replace(/\bpots?\b/g, "")
    .replace(/[\s-]+/g, " ")
    .trim();
  if (key === "") return { kind: "pot", number: "" };
  if (key === "main") return { kind: "main", number: "" };
  const side = key.match(/^side(?: (\d+))?$/);
  if (side) return { kind: "side", number: side[1] ?? "" };
  return { kind: null, number: "" };
}

/** The pill in the middle: "Pot", "Glavni", "Sporedni 2". */
function potName(name: string): string {
  const { kind, number } = readPot(name);
  if (kind === "pot") return "Pot";
  if (kind === "main") return "Glavni";
  if (kind === "side") return number ? `Sporedni ${number}` : "Sporedni";
  return name;
}

/** The same pile in a caption: "Glavni pot", "Sporedni pot 2". */
function potTitle(name: string): string {
  const { kind, number } = readPot(name);
  if (kind === "pot") return "Pot";
  if (kind === "main") return "Glavni pot";
  if (kind === "side") return number ? `Sporedni pot ${number}` : "Sporedni pot";
  return `Pot ${name}`;
}

/** Croatian takes the genitive singular after a decimal: "1,5 big blinda". */
function bigBlinds(bb: number): string {
  const word = Number.isInteger(bb) ? plural(bb, "big blind", "big blinda", "big blindova") : "big blinda";
  return `${num(bb)} ${word}`;
}

/**
 * The pill under a seat. Built from the action rather than translated from
 * the source's English wording, which is the room's own text.
 */
function actionLabel(action: PhfAction, money: (amount: Amount) => string): string {
  const amount = money(action.amount);
  switch (action.type) {
    case "ante":
      return `ante ${amount}`;
    case "small-blind":
      return `small blind ${amount}`;
    case "big-blind":
      return `big blind ${amount}`;
    case "straddle":
      return `straddle ${amount}`;
    case "post":
      return `post ${amount}`;
    case "missed-blind":
      return `propušteni blind ${amount}`;
    case "bomb-ante":
      return `bomb pot ante ${amount}`;
    case "call":
      return `call ${amount}`;
    case "bet":
      return `bet ${amount}`;
    case "raise":
      return `raise na ${money(action.streetTotal)}`;
    default:
      return action.label;
  }
}

export const replayerHr: Dict["replayer"] = {
  frames: {
    holeCardsDealt: "Podijeljene početne karte",
    chipsToPot: "Žetoni idu u pot",
    street: (street, board) => `${street.toUpperCase()} ${board.join(" ")}`,
    actionLabel,
    allIn: (label) => `${label} · all-in`,
    foldLabel: "fold",
    checkLabel: "check",
    showsLabel: "pokazuje",
    mucksLabel: "muck",
    acted: (player, label) => `${player}: ${label}`,
    folds: (player) => `${player}: fold`,
    checks: (player) => `${player}: check`,
    shows: (player, cards, description) =>
      `${player} pokazuje ${cards.join(" ")}${description ? ` (${description})` : ""}`,
    mucks: (player) => `${player}: muck`,
    uncalled: (player, amount) => `${player} dobiva natrag ${amount} (bez calla)`,
    wins: (player, amount) => `${player} osvaja ${amount}`,
    potAward: (pot, winners) => `${potTitle(pot)} — ${winners}`,
    potName,
    endOfHand: "Kraj ruke",
  },

  viewer: {
    roleDescription: "replayer pokerskih ruku",
    label: (game, stakes) => `Replayer ruke: ${game} ${stakes}.`,
    labelWithKeys: (game, stakes) =>
      `Replayer ruke: ${game} ${stakes}. Pritisni upitnik za prečace na tipkovnici.`,
    fullScreen: "Cijeli zaslon",
    fullScreenTitle: "Cijeli zaslon (F)",
    exitFullScreen: "Izađi iz cijelog zaslona",
    exitFullScreenTitle: "Izađi iz cijelog zaslona (F)",
    handInfo: "Podaci o ruci",
    handInfoTitle: "Podaci o ruci (I)",
    close: "Zatvori replayer",
    closeTitle: "Zatvori",
  },

  controls: {
    streets: {
      preflop: "Preflop",
      flop: "Flop",
      turn: "Turn",
      river: "River",
      showdown: "Showdown",
    },
    position: "Mjesto u ruci",
    positionValue: (step, total, caption) => `Korak ${num(step)} od ${num(total)}. ${caption}`,
    playback: "Reprodukcija",
    start: "Skoči na početak",
    startTitle: "Početak (Home)",
    previous: "Prethodna akcija",
    previousTitle: "Natrag (←)",
    play: "Pokreni",
    pause: "Pauza",
    playTitle: "Pokreni / pauziraj (razmaknica)",
    next: "Sljedeća akcija",
    nextTitle: "Naprijed (→)",
    end: "Skoči na kraj",
    endTitle: "Kraj (End)",
    jumpToStreet: "Skoči na street",
    speed: "Brzina reprodukcije",
    speedCycle: (speed) => `Brzina reprodukcije ${speed}×. Aktiviraj za sljedeću brzinu.`,
    speedOption: (speed) => `Brzina ${speed}×`,
    result: "Rezultat",
    log: "Popis akcija",
    logTitle: "Popis akcija (L)",
    logShort: "Akcije",
  },

  settings: {
    open: "Postavke replayera",
    title: "Postavke",
    bigBlinds: "Prikaži žetone u big blindovima",
    bigBlindsHint: "Stackovi, betovi i potovi u bb umjesto u valuti (B)",
    showKnownCards: "Prikaži poznate karte",
    showKnownCardsHint: "Otkrij svaku kartu koju history poznaje, i prije nego što je okrenuta (C)",
    showHeroCards: "Prikaži heroove karte",
    showHeroCardsHint: "Isključi za pregled ruke bez gledanja u heroove karte (H)",
    anonymousNames: "Anonimna imena",
    anonymousNamesHint: "Zamijeni imena igrača i stola s Hero / Igrač 1…",
    anonymousHero: "Hero",
    anonymousPlayer: (n) => `Igrač ${n}`,
    anonymousTable: "Stol",
  },

  log: {
    title: "Popis akcija",
  },

  keys: {
    title: "Tipkovnica",
    note: "Tipke rade dok je replayer u fokusu",
    space: "Razmaknica",
    items: {
      step: "Akcija natrag / naprijed",
      play: "Pokreni / pauziraj",
      ends: "Skoči na početak / na isplatu pota",
      streets: "Skoči na street",
      bigBlinds: "Žetoni u big blindovima",
      knownCards: "Prikaži svaku kartu koju history poznaje",
      heroCards: "Prikaži heroove karte",
      log: "Popis akcija",
      info: "Podaci o ruci",
      fullScreen: "Cijeli zaslon",
      help: "Ovaj popis",
      close: "Zatvori otvoreni prozor",
    },
  },

  info: {
    title: "Podaci o ruci",
    hidden: " skriveno dok se pot ne isplati",
    game: "Igra",
    structure: "Struktura",
    effectiveStack: "Efektivni stack",
    table: "Stol",
    hero: "Hero",
    seat: (seat) => `Sjedalo ${seat}`,
    tournament: "Turnir",
    level: (level) => `level ${level}`,
    source: "Izvor",
    handId: "ID ruke",
    played: "Odigrano",
    totalPot: "Ukupni pot",
    fees: "Naknade",
    none: "nema",
    winners: "Dobitnici",
    noneReported: "soba ih nije navela",
    run: (run) => ` (${run}. run)`,
    feeLabels: {
      rake: "Rake",
      jackpot: "Jackpot",
      bingo: "Bingo",
      fortune: "Fortune",
      tax: "Porez",
      other: "Ostale naknade",
    },
  },

  facts: {
    variants: {
      holdem: "Hold’em",
      omaha: "Omaha",
      omaha5: "Omaha s 5 karata",
      omaha6: "Omaha sa 6 karata",
      shortdeck: "Short deck",
      stud: "Stud",
      razz: "Razz",
      draw: "Draw",
    },
    bombPot: (ante) => `Bomb pot ${ante}`,
    doubleBoard: "Dvostruki board",
    bbAnte: (ante) => `BB ante ${ante}`,
    btnAnte: (ante) => `BTN ante ${ante}`,
    ante: (ante) => `Ante ${ante}`,
    straddle: (amount) => `Straddle ${amount}`,
    straddles: (count, amounts) =>
      `${num(count)} ${plural(count, "straddle", "straddlea", "straddleova")} ${amounts}`,
    tableShape: (max) => `${max}-max`,
    tableShapeDealt: (max, dealtIn) =>
      `${max}-max · ${num(dealtIn)} ${plural(dealtIn, "igrač", "igrača", "igrača")} u ruci`,
  },

  showdown: {
    showdownTitle: "Showdown",
    resultTitle: "Rezultat",
    pot: (amount) => `Pot ${amount}`,
    split: " · podijeljeni pot",
    cashedOut: (risk) => `cash out · rizik ${risk}`,
    mucked: "muck",
    folded: "fold",
    feeLabels: {
      rake: "rake",
      jackpot: "jackpot",
      bingo: "bingo",
      fortune: "fortune",
      tax: "porez",
      other: "ostalo",
    },
  },

  table: {
    logo: "Replayer ruku",
    pot: "Pot",
    potTotal: (amount) => `ukupno ${amount}`,
    board: "Board",
    secondRunout: "Drugi runout",
    runTwo: "Run 2",
    allIn: "ALL-IN",
    dealerButton: "Dealer button",
    folded: "Fold",
  },

  seat: {
    positions: {
      BTN: "button",
      SB: "small blind",
      BB: "big blind",
      UTG: "under the gun",
      "UTG+1": "under the gun plus jedan",
      "UTG+2": "under the gun plus dva",
      MP: "srednja pozicija",
      LJ: "lojack",
      HJ: "hijack",
      CO: "cutoff",
    },
    stack: bigBlinds,
    seat: (seat) => `Sjedalo ${seat}`,
    hero: "hero",
    dealerButton: "dealer button",
    inFront: (stack) => `${stack} uloženo na ovom streetu`,
    folded: "fold",
    allIn: "all-in",
    toAct: "na potezu",
    winner: "dobitnik",
  },

  card: {
    handed: (count) => `${num(count)} za stolom`,
    focus: (name, position) => `${name}, pozicija ${position}`,
    board: (cards) => `board ${cards}`,
    noFlop: "bez flopa",
    pot: (amount) => `pot ${amount}`,
    replay: (label) => `Odigraj: ${label}`,
  },

  playingCard: {
    ranks: {
      A: "as",
      K: "kralj",
      Q: "dama",
      J: "dečko",
      T: "desetka",
    },
    suits: {
      s: "pik",
      h: "herc",
      d: "karo",
      c: "tref",
    },
    card: (rank, suit) => `${rank} ${suit}`,
    faceDown: "karta licem prema dolje",
  },
};
