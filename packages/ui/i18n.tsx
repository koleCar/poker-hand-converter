"use client";

/**
 * The words the package's components show, handed in by the surface.
 *
 * `@rail/ui` holds no copy of its own (guideline §6: English by default,
 * translations prepared from the start; the i18n rule of both surfaces). Each
 * surface keeps its dictionaries where it always has - the web in
 * `frontend/src/lib/i18n/` (`replayer.{en,hr}.ts`, `stats.{en,hr}.ts`,
 * `chrome.{en,hr}.ts`), the app in `app/src/i18n/` - and mounts one
 * `UiStringsProvider` with the slices below for the reader's language. These
 * interfaces are the contract: a dictionary that lacks a key, or has a
 * function with the wrong arguments, is a type error where the surface builds
 * its `UiStrings`.
 *
 * The value should be stable per language (built once, not per render): the
 * components read it during render and some memoise on it.
 */

import { createContext, useContext, type ReactNode } from "react";
import type { ReplayStrings } from "./model/replay";

/** The replayer's strings: `frontend/src/lib/i18n/ns/replayer.en.ts` is the English. */
export interface ReplayerStrings {
  /** Handed to `buildReplay`, which writes the captions onto the frames. */
  frames: ReplayStrings;
  viewer: {
    roleDescription: string;
    label: (game: string, stakes: string) => string;
    labelWithKeys: (game: string, stakes: string) => string;
    fullScreen: string;
    fullScreenTitle: string;
    exitFullScreen: string;
    exitFullScreenTitle: string;
    handInfo: string;
    handInfoTitle: string;
    close: string;
    closeTitle: string;
  };
  controls: {
    streets: {
      preflop: string;
      flop: string;
      turn: string;
      river: string;
      showdown: string;
    };
    mark: (count: number, label: string) => string;
    position: string;
    positionValue: (step: number, total: number, caption: string) => string;
    playback: string;
    start: string;
    startTitle: string;
    previous: string;
    previousTitle: string;
    play: string;
    pause: string;
    playTitle: string;
    next: string;
    nextTitle: string;
    end: string;
    endTitle: string;
    jumpToStreet: string;
    speed: string;
    speedCycle: (speed: string) => string;
    speedOption: (speed: string) => string;
    result: string;
    log: string;
    logTitle: string;
    logShort: string;
  };
  settings: {
    open: string;
    title: string;
    bigBlinds: string;
    bigBlindsHint: string;
    showKnownCards: string;
    showKnownCardsHint: string;
    showHeroCards: string;
    showHeroCardsHint: string;
    anonymousNames: string;
    anonymousNamesHint: string;
    showPotOdds: string;
    showPotOddsHint: string;
    anonymousHero: string;
    anonymousPlayer: (n: number) => string;
    anonymousTable: string;
  };
  odds: {
    facingTitle: string;
    callToWin: (call: string, pot: string) => string;
    needEquity: (share: string) => string;
    betTitle: (share: string) => string;
    raiseTitle: (amount: string) => string;
    betInto: (risk: string, pot: string) => string;
    callerNeeds: string;
    bluffNeeds: string;
  };
  log: {
    title: string;
  };
  keys: {
    title: string;
    note: string;
    space: string;
    items: {
      step: string;
      play: string;
      ends: string;
      streets: string;
      bigBlinds: string;
      knownCards: string;
      heroCards: string;
      log: string;
      info: string;
      fullScreen: string;
      help: string;
      close: string;
    };
  };
  info: {
    title: string;
    hidden: string;
    game: string;
    structure: string;
    effectiveStack: string;
    table: string;
    hero: string;
    seat: (seat: number) => string;
    tournament: string;
    level: (level: string) => string;
    source: string;
    handId: string;
    played: string;
    totalPot: string;
    fees: string;
    none: string;
    winners: string;
    noneReported: string;
    run: (run: number) => string;
    feeLabels: {
      rake: string;
      jackpot: string;
      bingo: string;
      fortune: string;
      tax: string;
      other: string;
    };
  };
  facts: {
    variants: {
      holdem: string;
      omaha: string;
      omaha5: string;
      omaha6: string;
      shortdeck: string;
      stud: string;
      razz: string;
      draw: string;
    };
    bombPot: (ante: string) => string;
    doubleBoard: string;
    bbAnte: (ante: string) => string;
    btnAnte: (ante: string) => string;
    buttonBlind: (amount: string) => string;
    ante: (ante: string) => string;
    straddle: (amount: string) => string;
    straddles: (count: number, amounts: string) => string;
    tableShape: (max: number) => string;
    tableShapeDealt: (max: number, dealtIn: number) => string;
  };
  showdown: {
    showdownTitle: string;
    resultTitle: string;
    pot: (amount: string) => string;
    split: string;
    cashedOut: (risk: string) => string;
    mucked: string;
    folded: string;
    feeLabels: {
      rake: string;
      jackpot: string;
      bingo: string;
      fortune: string;
      tax: string;
      other: string;
    };
  };
  table: {
    logo: string;
    pot: string;
    potTotal: (amount: string) => string;
    board: string;
    secondRunout: string;
    runTwo: string;
    allIn: string;
    dealerButton: string;
    folded: string;
  };
  seat: {
    positions: {
      BTN: string;
      SB: string;
      BB: string;
      UTG: string;
      "UTG+1": string;
      "UTG+2": string;
      MP: string;
      LJ: string;
      HJ: string;
      CO: string;
    };
    stack: (bb: number) => string;
    seat: (seat: number) => string;
    hero: string;
    dealerButton: string;
    inFront: (stack: string) => string;
    folded: string;
    allIn: string;
    toAct: string;
    winner: string;
  };
  card: {
    handed: (count: number) => string;
    focus: (name: string, position: string) => string;
    board: (cards: string) => string;
    noFlop: string;
    pot: (amount: string) => string;
    replay: (label: string) => string;
  };
  playingCard: {
    ranks: { readonly [rank: string]: string };
    suits: {
      s: string;
      h: string;
      d: string;
      c: string;
    };
    card: (rank: string, suit: string) => string;
    faceDown: string;
  };

}

/** A statistic's tile (`StatTile`): the web's `stats.tile`. */
export interface StatTileStrings {
  /** By the reliability level (R2.5): the sample against the statistic's `sample.min`. */
  reliability: {
    ok: string;
    low: string;
    insufficient: string;
  };
  noOpportunities: string;
  /** Bounds already formatted, without the percent sign. */
  interval: (low: string, high: string) => string;
  /** A value's tooltip: the sample and the interval, all already formatted. */
  sample: (n: string, low: string, high: string) => string;
  noSample: string;
}

/** A table of statistics (`StatTable`); its tooltips reuse `StatTileStrings`. */
export interface StatTableStrings {
  /** Column headings. */
  statistic: string;
  value: string;
  sample: string;
  /** A value's tooltip when it has no interval (not a rate): its sample, already formatted. */
  sampleOnly: (n: string) => string;
}

export interface UiStrings {
  /** The reader's BCP 47 tag, for `Intl` ("en-GB", "hr-HR"). */
  intlLocale: string;
  /** The accessible name of a dialog's close button: "Close <what>". */
  closeNamed: (what: string) => string;
  replayer: ReplayerStrings;
  statTile: StatTileStrings;
  statTable: StatTableStrings;
}

const UiStringsContext = createContext<UiStrings | null>(null);

/** Mount once per surface, above anything from `@rail/ui`, with the reader's language. */
export function UiStringsProvider({ strings, children }: { strings: UiStrings; children: ReactNode }) {
  return <UiStringsContext.Provider value={strings}>{children}</UiStringsContext.Provider>;
}

/** The strings, in a component of this package. */
export function useUiStrings(): UiStrings {
  const strings = useContext(UiStringsContext);
  if (strings === null) {
    throw new Error("@rail/ui: mount a UiStringsProvider above this component (packages/ui/i18n.tsx).");
  }
  return strings;
}
