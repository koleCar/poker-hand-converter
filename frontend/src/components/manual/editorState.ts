/**
 * The manual-entry editor's state, and the small pure helpers around it.
 *
 * Everything the user typed lives in one serializable object, so it can be
 * kept in `localStorage` between visits (a half-entered hand survives a
 * reload) and so the betting can always be replayed from scratch by
 * `lib/manual/engine.ts` instead of being kept in sync by hand.
 *
 * Amounts are integer minor units of the game's unit, like everywhere in PHF.
 */

import {
  newManualHandId,
  unitFor,
  type AnteMode,
  type ManualAction,
  type ManualCurrency,
  type ManualLimit,
  type ManualSetup,
  type ManualTournament,
  type ManualVariant,
  type WinnerPicks,
} from "../../lib/manual";
import { formatAmount, type Amount, type CurrencyUnit } from "../../lib/phf/types";

export type AmountMode = "bb" | "money";

export interface EditorSeat {
  seat: number;
  taken: boolean;
  name: string;
  stack: Amount;
  cards: string[];
}

export interface EditorState {
  version: 1;
  format: "cash" | "tournament";
  currency: ManualCurrency;
  variant: ManualVariant;
  limit: ManualLimit;
  smallBlind: Amount;
  bigBlind: Amount;
  ante: Amount;
  anteMode: AnteMode;
  straddle: Amount;
  maxSeats: number;
  buttonSeat: number;
  heroSeat: number;
  /** One per seat at the table, taken or not. */
  seats: EditorSeat[];
  tableName: string;
  /** ISO 8601, UTC. */
  playedAt: string;
  tournament: ManualTournament;
  actions: ManualAction[];
  board: string[];
  rake: Amount;
  picks: WinnerPicks;
  amountMode: AmountMode;
  handId: string;
}

export const TABLE_SIZES = [2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

export const STORAGE_KEY = "rail.manualHand.v1";

export function defaultState(defaultName: (seat: number) => string): EditorState {
  const bigBlind = 50;
  return {
    version: 1,
    format: "cash",
    currency: "USD",
    variant: "holdem",
    limit: "nl",
    smallBlind: 25,
    bigBlind,
    ante: 0,
    anteMode: "none",
    straddle: 0,
    maxSeats: 6,
    buttonSeat: 6,
    heroSeat: 6,
    seats: Array.from({ length: 6 }, (_, i) => ({
      seat: i + 1,
      taken: true,
      name: i + 1 === 6 ? "Hero" : defaultName(i + 1),
      stack: 100 * bigBlind,
      cards: [],
    })),
    tableName: "",
    playedAt: new Date().toISOString(),
    tournament: { id: "", name: "", buyIn: 1000, fee: 100, buyInCurrency: "USD", level: 1 },
    actions: [],
    board: [],
    rake: 0,
    picks: {},
    amountMode: "bb",
    handId: newManualHandId(),
  };
}

/** Resizes the table, keeping the seats that still exist. */
export function withTableSize(state: EditorState, size: number, defaultName: (seat: number) => string): EditorState {
  const seats = Array.from({ length: size }, (_, i) => {
    const existing = state.seats[i];
    return (
      existing ?? {
        seat: i + 1,
        taken: true,
        name: defaultName(i + 1),
        stack: state.seats[0]?.stack ?? 100 * state.bigBlind,
        cards: [],
      }
    );
  });
  const clamp = (seat: number) => (seat > size ? size : seat);
  return { ...state, maxSeats: size, seats, buttonSeat: clamp(state.buttonSeat), heroSeat: clamp(state.heroSeat) };
}

export function setupOf(state: EditorState): ManualSetup {
  return {
    variant: state.variant,
    limit: state.limit,
    smallBlind: state.smallBlind,
    bigBlind: state.bigBlind,
    ante: state.anteMode === "none" ? 0 : state.ante,
    anteMode: state.anteMode,
    straddle: state.maxSeats > 2 ? state.straddle : 0,
    maxSeats: state.maxSeats,
    buttonSeat: state.buttonSeat,
    seats: state.seats
      .filter((seat) => seat.taken)
      .map((seat) => ({
        seat: seat.seat,
        name: seat.name.trim(),
        stack: seat.stack,
        hero: seat.seat === state.heroSeat,
        cards: seat.cards,
      })),
  };
}

export function unitOf(state: EditorState): CurrencyUnit {
  return unitFor(state);
}

/** Known cards per taken seat. */
export function cardsBySeat(state: EditorState): Map<number, string[]> {
  return new Map(state.seats.filter((seat) => seat.taken).map((seat) => [seat.seat, seat.cards]));
}

/** Every card in use, for blocking them in a picker. */
export function usedCards(state: EditorState): string[] {
  return [...state.seats.filter((seat) => seat.taken).flatMap((seat) => seat.cards), ...state.board];
}

/** Reads a stored editor state, or null when there is none or it does not fit. */
export function loadStored(): EditorState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as EditorState;
    if (parsed?.version !== 1 || !Array.isArray(parsed.seats) || !Array.isArray(parsed.actions)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function store(state: EditorState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Private mode or full storage: the editor still works, it just forgets.
  }
}

export function clearStored(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
}

/* -------------------------------------------------------------- amounts - */

const BB_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2, useGrouping: false });

/** An amount as the reader asked to see it: in big blinds, or in the game's unit. */
export function formatFor(amount: Amount, mode: AmountMode, unit: CurrencyUnit, bigBlind: Amount): string {
  if (mode === "bb" && bigBlind > 0) {
    return `${BB_FORMAT.format(amount / bigBlind)} bb`;
  }
  return formatAmount(amount, unit, "minimal", unit.minorUnits === 1);
}

/** The number an amount input shows, without the unit. */
export function amountText(amount: Amount, mode: AmountMode, unit: CurrencyUnit, bigBlind: Amount): string {
  if (mode === "bb" && bigBlind > 0) {
    return BB_FORMAT.format(amount / bigBlind);
  }
  return BB_FORMAT.format(amount / unit.minorUnits);
}

/** Reads what was typed into an amount input; null when it is not a number. */
export function parseAmountText(text: string, mode: AmountMode, unit: CurrencyUnit, bigBlind: Amount): Amount | null {
  const cleaned = text.trim().replace(/\s/g, "").replace(",", ".");
  if (cleaned === "" || !/^\d*\.?\d*$/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * (mode === "bb" && bigBlind > 0 ? bigBlind : unit.minorUnits));
}
