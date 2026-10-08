/**
 * Strings for the replayer components, English. Spread into `en.ts` as `replayer`;
 * `replayer.hr.ts` is the same shape. See the header of `en.ts`.
 *
 * `frames` is the one block that is not read by a component: it is handed to
 * `buildReplay` (`lib/replay.ts`), which writes the captions and action pills
 * onto the frames. Its English lives beside that pure module
 * (`lib/replayStrings.ts`) because the test harness builds frames without a
 * dictionary.
 */

import { ENGLISH_REPLAY_STRINGS } from "../../replayStrings";

export const replayerEn = {
  frames: ENGLISH_REPLAY_STRINGS,

  viewer: {
    roleDescription: "poker hand replayer",
    label: (game: string, stakes: string) => `${game} ${stakes} hand replayer.`,
    labelWithKeys: (game: string, stakes: string) =>
      `${game} ${stakes} hand replayer. Press question mark for keyboard shortcuts.`,
    fullScreen: "Full screen",
    fullScreenTitle: "Full screen (F)",
    exitFullScreen: "Exit full screen",
    exitFullScreenTitle: "Exit full screen (F)",
    handInfo: "Hand info",
    handInfoTitle: "Hand info (I)",
    close: "Close replayer",
    closeTitle: "Close",
  },

  controls: {
    streets: {
      preflop: "Preflop",
      flop: "Flop",
      turn: "Turn",
      river: "River",
      showdown: "Showdown",
    },
    mark: (count: number, label: string) => `${count} ${count === 1 ? "comment" : "comments"} at ${label}`,
    position: "Position in hand",
    positionValue: (step: number, total: number, caption: string) =>
      `Step ${step} of ${total}. ${caption}`,
    playback: "Playback",
    start: "Jump to start",
    startTitle: "Start (Home)",
    previous: "Previous action",
    previousTitle: "Back (←)",
    play: "Play",
    pause: "Pause",
    playTitle: "Play / pause (space)",
    next: "Next action",
    nextTitle: "Forward (→)",
    end: "Jump to end",
    endTitle: "End (End)",
    jumpToStreet: "Jump to street",
    speed: "Playback speed",
    speedCycle: (speed: string) => `Playback speed, ${speed} times. Activate for the next speed.`,
    speedOption: (speed: string) => `${speed} times speed`,
    result: "Result",
    log: "Action log",
    logTitle: "Action log (L)",
    logShort: "Log",
  },

  settings: {
    open: "Replayer settings",
    title: "Settings",
    bigBlinds: "Display chips in big blinds",
    bigBlindsHint: "Stacks, bets and pots in bb instead of currency (B)",
    showKnownCards: "Show known cards",
    showKnownCardsHint: "Reveal every card the history knows, before it was turned over (C)",
    showHeroCards: "Show hero hole cards",
    showHeroCardsHint: "Turn off to review the hand without seeing hero's holding (H)",
    anonymousNames: "Anonymous table names",
    anonymousNamesHint: "Replace player and table names with Hero / Player 1…",
    showPotOdds: "Show pot odds",
    showPotOddsHint: "Price of the spot in the top-left corner when hero faces or makes a bet",
    anonymousHero: "Hero",
    anonymousPlayer: (n: number) => `Player ${n}`,
    anonymousTable: "Table",
  },

  odds: {
    facingTitle: "Pot odds",
    callToWin: (call: string, pot: string) => `Call ${call} to win ${pot}`,
    needEquity: (share: string) => `need ${share} equity`,
    betTitle: (share: string) => `Bet ${share} pot`,
    raiseTitle: (amount: string) => `Raise to ${amount}`,
    betInto: (risk: string, pot: string) => `${risk} into ${pot}`,
    callerNeeds: "Caller needs equity",
    bluffNeeds: "Bluff needs folds",
  },

  log: {
    title: "Action log",
  },

  keys: {
    title: "Keyboard",
    note: "Keys work while the replayer has focus",
    space: "Space",
    items: {
      step: "Step back / forward one action",
      play: "Play / pause",
      ends: "Jump to the start / the award",
      streets: "Jump to a street",
      bigBlinds: "Chips in big blinds",
      knownCards: "Show every card the history knows",
      heroCards: "Show hero’s hole cards",
      log: "Action log",
      info: "Hand info",
      fullScreen: "Full screen",
      help: "This sheet",
      close: "Close the open sheet",
    },
  },

  info: {
    title: "Hand info",
    hidden: " hidden until the pot is awarded",
    game: "Game",
    structure: "Structure",
    effectiveStack: "Effective stack",
    table: "Table",
    hero: "Hero",
    seat: (seat: number) => `Seat ${seat}`,
    tournament: "Tournament",
    level: (level: string) => `level ${level}`,
    source: "Source",
    handId: "Hand id",
    played: "Played",
    totalPot: "Total pot",
    fees: "Fees",
    none: "none",
    winners: "Winners",
    noneReported: "none reported",
    run: (run: number) => ` (run ${run})`,
    feeLabels: {
      rake: "Rake",
      jackpot: "Jackpot",
      bingo: "Bingo",
      fortune: "Fortune",
      tax: "Tax",
      other: "Other fees",
    },
  },

  facts: {
    variants: {
      holdem: "Hold’em",
      omaha: "Omaha",
      omaha5: "5-card Omaha",
      omaha6: "6-card Omaha",
      shortdeck: "Short deck",
      stud: "Stud",
      razz: "Razz",
      draw: "Draw",
    },
    bombPot: (ante: string) => `Bomb pot ${ante}`,
    doubleBoard: "Double board",
    bbAnte: (ante: string) => `BB ante ${ante}`,
    btnAnte: (ante: string) => `BTN ante ${ante}`,
    /** GG's short deck: the one blind of an ante-only table, on the button. */
    buttonBlind: (amount: string) => `Button blind ${amount}`,
    ante: (ante: string) => `Ante ${ante}`,
    straddle: (amount: string) => `Straddle ${amount}`,
    straddles: (count: number, amounts: string) => `${count} straddles ${amounts}`,
    tableShape: (max: number) => `${max}-max`,
    tableShapeDealt: (max: number, dealtIn: number) => `${max}-max · ${dealtIn} dealt in`,
  },

  showdown: {
    showdownTitle: "Showdown",
    resultTitle: "Result",
    pot: (amount: string) => `Pot ${amount}`,
    split: " · split",
    cashedOut: (risk: string) => `cashed out · risk ${risk}`,
    mucked: "mucked",
    folded: "folded",
    feeLabels: {
      rake: "rake",
      jackpot: "jackpot",
      bingo: "bingo",
      fortune: "fortune",
      tax: "tax",
      other: "other",
    },
  },

  table: {
    logo: "Hand Replayer",
    pot: "Pot",
    potTotal: (amount: string) => `${amount} total`,
    board: "Board",
    secondRunout: "Second runout",
    runTwo: "Run 2",
    allIn: "ALL-IN",
    dealerButton: "Dealer button",
    folded: "Folded",
  },

  seat: {
    positions: {
      BTN: "button",
      SB: "small blind",
      BB: "big blind",
      UTG: "under the gun",
      "UTG+1": "under the gun plus one",
      "UTG+2": "under the gun plus two",
      MP: "middle position",
      LJ: "lojack",
      HJ: "hijack",
      CO: "cutoff",
    },
    /** "84 big blinds", "1.5 big blinds", "1 big blind". */
    stack: (bb: number) => `${bb} big blind${bb === 1 ? "" : "s"}`,
    seat: (seat: number) => `Seat ${seat}`,
    hero: "hero",
    dealerButton: "dealer button",
    inFront: (stack: string) => `${stack} in front`,
    folded: "folded",
    allIn: "all in",
    toAct: "to act",
    winner: "winner",
  },

  card: {
    handed: (count: number) => `${count}-handed`,
    focus: (name: string, position: string) => `${name} in the ${position}`,
    board: (cards: string) => `board ${cards}`,
    noFlop: "no flop",
    pot: (amount: string) => `${amount} pot`,
    replay: (label: string) => `Replay ${label}`,
  },

  playingCard: {
    ranks: {
      A: "Ace",
      K: "King",
      Q: "Queen",
      J: "Jack",
      T: "Ten",
    } as Record<string, string>,
    suits: {
      s: "spades",
      h: "hearts",
      d: "diamonds",
      c: "clubs",
    },
    card: (rank: string, suit: string) => `${rank} of ${suit}`,
    faceDown: "face-down card",
  },
} as const;
