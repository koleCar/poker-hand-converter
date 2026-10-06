/**
 * Manual hand entry: the betting engine.
 *
 * The editor at `/convert/manual` keeps three things — the setup (game, seats,
 * stacks, blinds), a flat list of the decisions the user clicked, and the board
 * — and this module replays them into the state of the hand: whose turn it is,
 * what they may do and for how much, when a street closes, when the hand is
 * over. Nothing is stored that can be derived, so editing a stack after the
 * action is entered simply replays everything again; the first decision that no
 * longer fits is where the replay stops (`validCount`), and the editor drops the
 * rest.
 *
 * The rules are the dealer's, not a room's:
 *
 *  - blinds, antes and a straddle are posted for the user, from the setup;
 *  - preflop action starts left of the last blind (or the straddle), postflop
 *    left of the button — heads-up that makes the button act first preflop and
 *    last after the flop, with no special case;
 *  - a raise must be at least the previous raise, except an all-in for less;
 *    an all-in for less does not reopen the betting to players who already
 *    acted;
 *  - pot limit caps a raise at the pot after the call.
 *
 * Pure TypeScript and DOM-free, like the rest of `lib/`: the test harness
 * imports it.
 */

import { resolvePositions, type Amount, type Position } from "../phf/types";

export type ManualVariant = "holdem" | "omaha" | "omaha5";
export type ManualLimit = "nl" | "pl";
export type ManualStreet = "preflop" | "flop" | "turn" | "river";
export const MANUAL_STREETS: ManualStreet[] = ["preflop", "flop", "turn", "river"];
export type AnteMode = "none" | "each" | "bb";

/** Hole cards dealt to each player in a variant. */
export const HOLE_CARDS: Record<ManualVariant, number> = { holdem: 2, omaha: 4, omaha5: 5 };

/** Board cards on the table once a street is dealt. */
export const BOARD_SIZE: Record<ManualStreet, number> = { preflop: 0, flop: 3, turn: 4, river: 5 };

export interface ManualSeat {
  seat: number;
  name: string;
  /** Starting stack, minor units. */
  stack: Amount;
  hero: boolean;
  /** Known hole cards; empty when unknown. */
  cards: string[];
}

export interface ManualSetup {
  variant: ManualVariant;
  limit: ManualLimit;
  smallBlind: Amount;
  bigBlind: Amount;
  ante: Amount;
  anteMode: AnteMode;
  /** The UTG straddle; 0 for none. Ignored heads-up. */
  straddle: Amount;
  maxSeats: number;
  buttonSeat: number;
  /** Occupied seats only. */
  seats: ManualSeat[];
}

export type ManualActionKind = "fold" | "check" | "call" | "bet" | "raise";

/** One decision the user entered. */
export interface ManualAction {
  seat: number;
  kind: ManualActionKind;
  /** Bet and raise only: the player's total for the street after the action. */
  to?: Amount;
}

export type PostingKind = "ante" | "small-blind" | "big-blind" | "straddle";

/** One line of the hand as it played out, postings included. */
export interface LoggedAction {
  /** Index into the entered actions; null for a posting. */
  index: number | null;
  street: ManualStreet;
  seat: number;
  name: string;
  kind: ManualActionKind | PostingKind;
  /** Chips this action put in. */
  added: Amount;
  /** The player's street total afterwards (0 for an ante, which is dead). */
  to: Amount;
  allIn: boolean;
  /** Pot before this action, every street included. */
  potBefore: Amount;
}

export interface PlayerState {
  seat: number;
  name: string;
  position: Position | null;
  hero: boolean;
  startingStack: Amount;
  /** Behind, after everything so far. */
  stack: Amount;
  /** Live chips on the current street. */
  commit: Amount;
  /** Everything put in, antes included. */
  contributed: Amount;
  folded: boolean;
  foldedStreet: ManualStreet | null;
  allIn: boolean;
  /** Has acted since the last full raise. */
  acted: boolean;
  /** May still raise (an all-in for less does not reopen the action). */
  canRaise: boolean;
}

/** What the player to act may do, with the amounts already worked out. */
export interface ActionOptions {
  seat: number;
  toCall: Amount;
  canCheck: boolean;
  canCall: boolean;
  /** Chips a call adds; less than `toCall` when the call is all-in. */
  callAmount: Amount;
  callIsAllIn: boolean;
  /** Bet when nobody has, raise otherwise. */
  aggressive: "bet" | "raise" | null;
  /** Street totals the bet or raise may go to, inclusive. */
  minTo: Amount;
  maxTo: Amount;
  /** The player's whole stack as a street total. */
  allInTo: Amount;
  /** Current bet on the street, i.e. what a raise is over. */
  currentBet: Amount;
  /** Pot including every street's chips so far. */
  pot: Amount;
}

export type EngineStatus =
  | { kind: "betting"; options: ActionOptions }
  /** The street closed and the next one needs `street`'s cards before anyone can act. */
  | { kind: "needs-board"; street: Exclude<ManualStreet, "preflop">; runout: boolean }
  | { kind: "complete"; ending: "fold" | "showdown" };

export interface EngineState {
  setup: ManualSetup;
  players: PlayerState[];
  /** The street being bet, or the last one that was. */
  street: ManualStreet;
  log: LoggedAction[];
  /** Live commitment per street per seat, for the uncalled bet. */
  streetCommits: Map<ManualStreet, Map<number, Amount>>;
  pot: Amount;
  status: EngineStatus;
  /** How many of the entered actions were legal; the rest were ignored. */
  validCount: number;
  /** Why action `validCount` was refused, if one was. */
  rejected: string | null;
  /** Board cards the hand has reached (0, 3, 4 or 5). */
  boardReached: number;
}

/* ----------------------------------------------------------------- setup - */

/** Seats in table order starting left of the button. */
function ringFromButton(setup: ManualSetup): ManualSeat[] {
  const seats = [...setup.seats].sort((a, b) => a.seat - b.seat);
  const buttonIndex = seats.findIndex((seat) => seat.seat === setup.buttonSeat);
  if (buttonIndex < 0) {
    return seats;
  }
  return [...seats.slice(buttonIndex + 1), ...seats.slice(0, buttonIndex + 1)];
}

/** Problems with the setup itself; the engine refuses to run while there are any. */
export type SetupProblem =
  | "too-few-players"
  | "no-button"
  | "no-blinds"
  | "blinds-order"
  | "names"
  | "duplicate-names"
  | "stacks"
  | "no-hero";

export function setupProblems(setup: ManualSetup): SetupProblem[] {
  const problems: SetupProblem[] = [];
  if (setup.seats.length < 2) problems.push("too-few-players");
  if (!setup.seats.some((seat) => seat.seat === setup.buttonSeat)) problems.push("no-button");
  if (setup.bigBlind <= 0) problems.push("no-blinds");
  if (setup.smallBlind > setup.bigBlind) problems.push("blinds-order");
  if (setup.seats.some((seat) => !isUsableName(seat.name))) problems.push("names");
  const names = setup.seats.map((seat) => seat.name.trim());
  if (new Set(names).size !== names.length) problems.push("duplicate-names");
  if (setup.seats.some((seat) => !(seat.stack > 0))) problems.push("stacks");
  if (setup.seats.filter((seat) => seat.hero).length !== 1) problems.push("no-hero");
  return problems;
}

/**
 * A name the standard text can carry back unambiguously.
 *
 * The text is line-oriented and its grammar is `Name: verb`, `Seat 3: Name (…`,
 * `Dealt to Name [cards]`, so colons, brackets and parentheses in a name would
 * be read as structure.
 */
export function isUsableName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= 40 && !/[:[\]()\n\r]/.test(trimmed);
}

/** Who posts what, in table order. */
export function blindSeats(setup: ManualSetup): { sb: number | null; bb: number | null; straddle: number | null } {
  const ring = ringFromButton(setup);
  if (ring.length < 2) {
    return { sb: null, bb: null, straddle: null };
  }
  if (ring.length === 2) {
    // Heads-up the button posts the small blind; `ring` ends with the button.
    return { sb: ring[1].seat, bb: ring[0].seat, straddle: null };
  }
  return {
    sb: ring[0].seat,
    bb: ring[1].seat,
    straddle: setup.straddle > 0 ? ring[2 % ring.length].seat : null,
  };
}

/* ---------------------------------------------------------------- replay - */

export function replayManual(
  setup: ManualSetup,
  actions: readonly ManualAction[],
  board: readonly string[],
): EngineState {
  const positions = resolvePositions(
    setup.seats.map((seat) => seat.seat),
    setup.buttonSeat,
  );
  const ring = ringFromButton(setup);
  const players: PlayerState[] = ring.map((seat) => ({
    seat: seat.seat,
    name: seat.name.trim(),
    position: positions.get(seat.seat) ?? null,
    hero: seat.hero,
    startingStack: seat.stack,
    stack: seat.stack,
    commit: 0,
    contributed: 0,
    folded: false,
    foldedStreet: null,
    allIn: false,
    acted: false,
    canRaise: true,
  }));
  const bySeat = new Map(players.map((player) => [player.seat, player]));

  const state: EngineState = {
    setup,
    players,
    street: "preflop",
    log: [],
    streetCommits: new Map(MANUAL_STREETS.map((street) => [street, new Map()])),
    pot: 0,
    status: { kind: "complete", ending: "fold" },
    validCount: 0,
    rejected: null,
    boardReached: 0,
  };

  let bet = 0;
  let lastRaise = setup.bigBlind;
  /** Seat index the next search for an actor starts after. */
  let cursor = -1;

  const record = (player: PlayerState, kind: LoggedAction["kind"], added: Amount, index: number | null) => {
    state.log.push({
      index,
      street: state.street,
      seat: player.seat,
      name: player.name,
      kind,
      added,
      to: kind === "ante" ? 0 : player.commit,
      allIn: player.allIn,
      potBefore: state.pot,
    });
    state.pot += added;
  };

  /** Puts up to `amount` live chips in; returns what actually went in. */
  const put = (player: PlayerState, amount: Amount, live = true): Amount => {
    const added = Math.max(0, Math.min(amount, player.stack));
    player.stack -= added;
    player.contributed += added;
    if (live) {
      player.commit += added;
      state.streetCommits.get(state.street)!.set(player.seat, player.commit);
    }
    if (player.stack === 0) {
      player.allIn = true;
    }
    return added;
  };

  /* Postings. */
  if (setupProblems(setup).length > 0) {
    state.status = { kind: "complete", ending: "fold" };
    state.rejected = actions.length > 0 ? "setup" : null;
    return state;
  }
  const blinds = blindSeats(setup);
  if (setup.ante > 0 && setup.anteMode === "each") {
    for (const player of players) {
      record(player, "ante", put(player, setup.ante, false), null);
    }
  }
  if (setup.ante > 0 && setup.anteMode === "bb" && blinds.bb !== null) {
    const player = bySeat.get(blinds.bb)!;
    record(player, "ante", put(player, setup.ante, false), null);
  }
  if (blinds.sb !== null && setup.smallBlind > 0) {
    const player = bySeat.get(blinds.sb)!;
    record(player, "small-blind", put(player, setup.smallBlind), null);
  }
  if (blinds.bb !== null) {
    const player = bySeat.get(blinds.bb)!;
    record(player, "big-blind", put(player, setup.bigBlind), null);
    cursor = players.indexOf(player);
  }
  bet = setup.bigBlind;
  if (blinds.straddle !== null && setup.straddle > setup.bigBlind) {
    const player = bySeat.get(blinds.straddle)!;
    record(player, "straddle", put(player, setup.straddle), null);
    cursor = players.indexOf(player);
    bet = setup.straddle;
    lastRaise = setup.straddle;
  }

  const live = () => players.filter((player) => !player.folded);
  const able = () => players.filter((player) => !player.folded && !player.allIn);

  /** Next seat to act after `cursor`, or null when the street is closed. */
  const nextActor = (): PlayerState | null => {
    const canAct = able();
    if (canAct.length === 0) return null;
    if (canAct.length === 1 && canAct[0].commit >= bet) return null;
    for (let step = 1; step <= players.length; step += 1) {
      const player = players[(cursor + step + players.length) % players.length];
      if (player.folded || player.allIn) continue;
      if (!player.acted || player.commit < bet) return player;
    }
    return null;
  };

  const optionsFor = (player: PlayerState): ActionOptions => {
    const toCall = Math.max(0, bet - player.commit);
    const allInTo = player.commit + player.stack;
    const othersCanAct = able().some((other) => other !== player);
    let aggressive: ActionOptions["aggressive"] = null;
    let minTo = 0;
    let maxTo = 0;
    if (allInTo > bet && othersCanAct && (bet === 0 || player.canRaise)) {
      aggressive = bet === 0 ? "bet" : "raise";
      minTo = Math.min(allInTo, bet === 0 ? setup.bigBlind : bet + lastRaise);
      maxTo = allInTo;
      if (setup.limit === "pl") {
        // The pot after calling, on top of the call.
        maxTo = Math.min(allInTo, player.commit + toCall + state.pot + toCall);
        minTo = Math.min(minTo, maxTo);
      }
    }
    return {
      seat: player.seat,
      toCall,
      canCheck: toCall === 0,
      canCall: toCall > 0,
      callAmount: Math.min(toCall, player.stack),
      callIsAllIn: toCall >= player.stack,
      aggressive,
      minTo,
      maxTo,
      allInTo,
      currentBet: bet,
      pot: state.pot,
    };
  };

  /** Moves to the next street, or settles the hand; returns false when it has to wait for cards. */
  const advance = (): boolean => {
    if (live().length === 1) {
      state.status = { kind: "complete", ending: "fold" };
      return true;
    }
    const runout = able().length <= 1;
    if (state.street === "river" || runout) {
      if (board.length < 5) {
        const missing = MANUAL_STREETS.find((street) => BOARD_SIZE[street] > board.length)!;
        state.status = {
          kind: "needs-board",
          street: missing as Exclude<ManualStreet, "preflop">,
          runout: state.street !== "river",
        };
        return false;
      }
      state.boardReached = 5;
      state.status = { kind: "complete", ending: "showdown" };
      return true;
    }
    const next = MANUAL_STREETS[MANUAL_STREETS.indexOf(state.street) + 1];
    if (board.length < BOARD_SIZE[next]) {
      state.status = { kind: "needs-board", street: next as Exclude<ManualStreet, "preflop">, runout: false };
      return false;
    }
    state.street = next;
    state.boardReached = BOARD_SIZE[next];
    bet = 0;
    lastRaise = setup.bigBlind;
    for (const player of players) {
      player.commit = 0;
      player.acted = false;
      player.canRaise = true;
    }
    // Postflop the first seat left of the button acts first; `players` starts there.
    cursor = players.length - 1;
    return true;
  };

  /** Works out the status after the last change; true if betting continues. */
  const settleStatus = (): boolean => {
    for (;;) {
      if (live().length === 1) {
        state.status = { kind: "complete", ending: "fold" };
        return false;
      }
      const actor = nextActor();
      if (actor) {
        state.status = { kind: "betting", options: optionsFor(actor) };
        return true;
      }
      if (!advance()) return false;
      if (state.status.kind === "complete") return false;
    }
  };

  const applyAction = (
    player: PlayerState,
    entry: ManualAction,
    opts: ActionOptions,
    index: number,
  ): string | null => {
    switch (entry.kind) {
      case "fold":
        if (opts.canCheck) return "fold-when-check";
        player.folded = true;
        player.foldedStreet = state.street;
        player.acted = true;
        record(player, "fold", 0, index);
        return null;
      case "check":
        if (!opts.canCheck) return "check-facing-bet";
        player.acted = true;
        record(player, "check", 0, index);
        return null;
      case "call": {
        if (!opts.canCall) return "nothing-to-call";
        const added = put(player, opts.toCall);
        player.acted = true;
        record(player, "call", added, index);
        return null;
      }
      case "bet":
      case "raise": {
        if (opts.aggressive !== entry.kind) return `no-${entry.kind}`;
        const to = entry.to ?? 0;
        const isAllIn = to === opts.allInTo;
        if (to > opts.maxTo || (to < opts.minTo && !isAllIn) || to <= bet) return "size";
        const increment = to - bet;
        const full = increment >= lastRaise;
        const added = put(player, to - player.commit);
        for (const other of players) {
          if (other === player || other.folded || other.allIn) continue;
          if (full) {
            other.canRaise = true;
          } else if (other.acted) {
            // An all-in for less re-opens nothing to a player who already acted.
            other.canRaise = false;
          }
          other.acted = false;
        }
        if (full) lastRaise = increment;
        bet = to;
        player.acted = true;
        record(player, entry.kind, added, index);
        return null;
      }
    }
  };

  settleStatus();

  for (let index = 0; index < actions.length; index += 1) {
    const status = state.status;
    if (status.kind !== "betting") {
      state.rejected = "hand-over";
      break;
    }
    const action = actions[index];
    if (action.seat !== status.options.seat) {
      state.rejected = "not-your-turn";
      break;
    }
    const player = bySeat.get(action.seat)!;
    const problem = applyAction(player, action, status.options, index);
    if (problem) {
      state.rejected = problem;
      break;
    }
    state.validCount = index + 1;
    cursor = players.indexOf(player);
    settleStatus();
  }

  return state;
}
