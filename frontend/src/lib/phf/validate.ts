/**
 * PHF validator.
 *
 * A hand history is user-supplied data from a room we do not control, and the
 * rooms do emit broken hands: ghost antes from players who are not seated,
 * bets from a zero stack, a river with no turn. Storing those silently is worse
 * than rejecting them, because every statistic computed later inherits the lie.
 *
 * The checks below are the ones `backend/test/` has always asserted against the
 * real sample files, moved here so there is a single implementation:
 *
 *  - chip conservation: what went in equals the reported pot
 *  - payout conservation: what came out equals the pot minus the fees
 *  - no stack goes negative at any point in the action stream
 *  - every actor is a seated player
 *  - the board size is a legal one and matches the street reached
 *  - no card appears twice anywhere in the hand
 *
 * `error` means the hand is not trustworthy and must not be stored as a normal
 * hand. `warning` means it is usable but odd and worth surfacing in the UI.
 */

import { parseCard } from "../cards";
import {
  holeCardCount,
  resolveRunout,
  totalFees,
  type Amount,
  type PhfHand,
} from "./types";

export type Severity = "error" | "warning";

export interface ValidationProblem {
  /** Short machine code; doubles as the `reason` on a `ConversionFailure`. */
  code: string;
  message: string;
  severity: Severity;
  /** Player, seat, action index - whatever makes the problem reproducible. */
  context?: Record<string, string | number>;
}

export interface ValidationReport {
  ok: boolean;
  errors: ValidationProblem[];
  warnings: ValidationProblem[];
  problems: ValidationProblem[];
}

/**
 * Sources round their own arithmetic, so one minor unit of slack (one cent, or
 * one chip) is tolerated on every sum. More than that is a real mismatch.
 */
const TOLERANCE: Amount = 1;

/**
 * Every distinct card in the hand.
 *
 * Run-it-twice runouts share the streets they did not re-deal, so only the
 * streets a later runout actually re-dealt are counted; otherwise a shared flop
 * would look like three duplicates.
 */
export function distinctCardUses(hand: PhfHand): Array<{ card: string; where: string }> {
  const uses: Array<{ card: string; where: string }> = [];
  for (const player of hand.players) {
    for (const card of player.holeCards) {
      uses.push({ card, where: `seat ${player.seat} (${player.name})` });
    }
  }
  for (let i = 0; i < hand.board.runouts.length; i += 1) {
    const run = hand.board.runouts[i];
    const resolved = resolveRunout(hand.board, i);
    if (i === 0) {
      resolved.forEach((card) => uses.push({ card, where: "board" }));
      continue;
    }
    if (run.flop) {
      resolved.slice(0, 3).forEach((card) => uses.push({ card, where: `runout ${i} flop` }));
    }
    if (run.turn) {
      uses.push({ card: run.turn, where: `runout ${i} turn` });
    }
    if (run.river) {
      uses.push({ card: run.river, where: `runout ${i} river` });
    }
  }
  return uses;
}

export function validateHand(hand: PhfHand): ValidationReport {
  const problems: ValidationProblem[] = [];
  const unit = hand.game.unit;

  const error = (code: string, message: string, context?: ValidationProblem["context"]) => {
    problems.push({ code, message, severity: "error", context });
  };
  const warn = (code: string, message: string, context?: ValidationProblem["context"]) => {
    problems.push({ code, message, severity: "warning", context });
  };

  if (hand.schema !== "phf/1") {
    error("bad-schema", `Unsupported schema tag "${hand.schema}".`);
  }

  /* ------------------------------------------------------------- seating - */

  const seated = new Map<string, number>();
  const seatNumbers = new Set<number>();
  for (const player of hand.players) {
    if (seated.has(player.name)) {
      error("duplicate-player", `Player "${player.name}" is seated twice.`, {
        player: player.name,
      });
    }
    if (seatNumbers.has(player.seat)) {
      error("duplicate-seat", `Seat ${player.seat} is occupied twice.`, { seat: player.seat });
    }
    seated.set(player.name, player.seat);
    seatNumbers.add(player.seat);
  }

  if (hand.players.length === 0) {
    error("no-players", "The hand has no seated players.");
  }
  if (hand.table.buttonSeat === null) {
    warn("missing-button", "The button seat is unknown, so positions cannot be resolved.");
  } else if (!seatNumbers.has(hand.table.buttonSeat)) {
    warn("button-not-seated", `The button is on seat ${hand.table.buttonSeat}, which is empty.`, {
      seat: hand.table.buttonSeat,
    });
  }
  if (!hand.players.some((player) => player.isHero)) {
    warn("no-hero", "No seat is marked as the hero.");
  }

  /* ------------------------------------------------------------- actors -- */

  for (const action of hand.actions) {
    if (!seated.has(action.player)) {
      error("unseated-actor", `"${action.player}" acts but is not seated.`, {
        player: action.player,
        action: action.index,
        line: action.sourceLine ?? -1,
      });
    }
  }

  /* --------------------------------------------------------------- cards - */

  const seen = new Map<string, string>();
  for (const use of distinctCardUses(hand)) {
    if (!parseCard(use.card)) {
      error("invalid-card", `"${use.card}" is not a valid card (${use.where}).`);
      continue;
    }
    const previous = seen.get(use.card);
    if (previous) {
      error("duplicate-card", `${use.card} appears in both ${previous} and ${use.where}.`, {
        card: use.card,
      });
      continue;
    }
    seen.set(use.card, use.where);
  }

  const expectedHoleCards = holeCardCount(hand.game.variant);
  if (expectedHoleCards !== null) {
    for (const player of hand.players) {
      if (player.holeCards.length > 0 && player.holeCards.length !== expectedHoleCards) {
        warn(
          "hole-card-count",
          `${player.name} has ${player.holeCards.length} hole cards; ` +
            `${hand.game.variant} deals ${expectedHoleCards}.`,
          { player: player.name },
        );
      }
    }
  }

  /* --------------------------------------------------------------- board - */

  for (let i = 0; i < hand.board.runouts.length; i += 1) {
    const cards = resolveRunout(hand.board, i);
    if (![0, 3, 4, 5].includes(cards.length)) {
      error("board-size", `Runout ${i} has ${cards.length} cards, which is not a legal board.`, {
        runout: i,
      });
    }
    const run = hand.board.runouts[i];
    if (run.turn && !(run.flop ?? hand.board.runouts[0]?.flop)) {
      error("turn-without-flop", `Runout ${i} has a turn but no flop.`, { runout: i });
    }
    if (run.river && !(run.turn ?? hand.board.runouts[0]?.turn)) {
      error("river-without-turn", `Runout ${i} has a river but no turn.`, { runout: i });
    }
  }

  const primary = resolveRunout(hand.board, 0);
  const expectedByStreet: Record<string, number> = {
    preflop: 0,
    flop: 3,
    turn: 4,
    river: 5,
    showdown: primary.length,
  };
  const expected = expectedByStreet[hand.results.streetReached];
  if (expected !== undefined && primary.length !== expected) {
    warn(
      "board-street-mismatch",
      `Street reached is ${hand.results.streetReached} but the board has ` +
        `${primary.length} cards.`,
    );
  }

  /* ---------------------------------------------------------- chip flows - */

  const contributed = new Map<string, Amount>();
  const collected = new Map<string, Amount>();
  const stacks = new Map<string, Amount>();
  for (const player of hand.players) {
    stacks.set(player.name, player.startingStack);
  }

  for (const action of hand.actions) {
    if (action.type === "collect") {
      collected.set(action.player, (collected.get(action.player) ?? 0) + action.amount);
      continue;
    }
    if (action.amount === 0) {
      continue;
    }
    contributed.set(action.player, (contributed.get(action.player) ?? 0) + action.amount);
    const stack = stacks.get(action.player);
    if (stack === undefined) {
      continue;
    }
    const next = stack - action.amount;
    stacks.set(action.player, next);
    if (next < -TOLERANCE) {
      error(
        "negative-stack",
        `${action.player} is ${-next} below zero after "${action.rawLine}".`,
        { player: action.player, action: action.index, line: action.sourceLine ?? -1 },
      );
    }
  }

  const totalIn = [...contributed.values()].reduce((sum, value) => sum + value, 0);
  const totalOut = [...collected.values()].reduce((sum, value) => sum + value, 0);
  const fees = totalFees(hand.results.fees);

  if (Math.abs(totalIn - hand.results.totalPot) > TOLERANCE) {
    error(
      "chip-mismatch",
      `Players put in ${totalIn} but the hand reports a pot of ${hand.results.totalPot}.`,
      { in: totalIn, pot: hand.results.totalPot },
    );
  }

  // Rooms disagree on whether "Total pot" is before or after the rake. GG
  // deducts (pot 3, rake 0.15, collected 2.85); WePlay reports the rake
  // alongside a pot the winner collects in full. Both are internally
  // consistent, so both are accepted and only a third answer is an error.
  if (totalOut > 0) {
    const feesDeducted = Math.abs(totalOut + fees - hand.results.totalPot) <= TOLERANCE;
    const feesSeparate = Math.abs(totalOut - hand.results.totalPot) <= TOLERANCE;
    if (!feesDeducted && !feesSeparate) {
      error(
        "payout-mismatch",
        `Winners collected ${totalOut} and fees were ${fees}, which matches neither ` +
          `the reported pot of ${hand.results.totalPot} nor that pot minus fees.`,
        { out: totalOut, fees, pot: hand.results.totalPot },
      );
    }
  }

  if (totalOut === 0) {
    warn("no-winner", "Nobody collected the pot.");
  }

  // An uncalled return can never exceed what the player actually put in on the
  // street; when it does, the source text is internally inconsistent.
  const streetCommit = new Map<string, Amount>();
  let currentKey = "preflop:0";
  for (const action of hand.actions) {
    const key = `${action.street}:${action.runoutIndex}`;
    if (key !== currentKey) {
      currentKey = key;
      streetCommit.clear();
    }
    if (action.type === "uncalled") {
      const committed = streetCommit.get(action.player) ?? 0;
      if (-action.amount > committed + TOLERANCE) {
        error(
          "uncalled-exceeds-commitment",
          `${action.player} is returned ${-action.amount} but only committed ${committed}.`,
          { player: action.player, action: action.index },
        );
      }
    }
    streetCommit.set(action.player, (streetCommit.get(action.player) ?? 0) + action.amount);
  }

  /* ------------------------------------------------------- reported sums - */

  for (const result of hand.results.players) {
    const actual = contributed.get(result.player) ?? 0;
    if (Math.abs(actual - result.contributed) > TOLERANCE) {
      warn(
        "contribution-mismatch",
        `${result.player}: results say ${result.contributed} in, the stream says ${actual}.`,
        { player: result.player },
      );
    }
    const won = collected.get(result.player) ?? 0;
    if (Math.abs(won - result.won) > TOLERANCE) {
      warn(
        "winnings-mismatch",
        `${result.player}: results say ${result.won} won, the stream says ${won}.`,
        { player: result.player },
      );
    }
  }

  if (hand.game.bigBlind <= 0 && unit.kind === "cash") {
    warn("missing-blinds", "The hand does not state a big blind.");
  }

  /* ------------------------------------------------- parser-side warnings - */

  for (const warning of hand.meta.warnings) {
    warn(warning.code, warning.message, warning.line ? { line: warning.line } : undefined);
  }

  const errors = problems.filter((problem) => problem.severity === "error");
  const warnings = problems.filter((problem) => problem.severity === "warning");
  return { ok: errors.length === 0, errors, warnings, problems };
}

/** One-line summary for logs and the failures table. */
export function describeReport(report: ValidationReport): string {
  if (report.ok && report.warnings.length === 0) {
    return "valid";
  }
  const parts: string[] = [];
  if (report.errors.length > 0) {
    parts.push(`${report.errors.length} error(s): ${report.errors.map((p) => p.code).join(", ")}`);
  }
  if (report.warnings.length > 0) {
    parts.push(
      `${report.warnings.length} warning(s): ${[
        ...new Set(report.warnings.map((p) => p.code)),
      ].join(", ")}`,
    );
  }
  return parts.join("; ");
}
