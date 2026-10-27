/**
 * Manual hand entry: from the editor's state to a PHF hand.
 *
 * A hand typed in by hand is treated like a hand from one more room. The
 * replayed betting becomes a `HandDraft`, `parsers/shared/p2-handbuilder.ts`
 * writes it as standard text, and `parseStandardHand` reads that back — so the summary block, positions, results
 * and the text round trip are the same code every imported hand goes through,
 * and `validateHand` judges the result by the same rules. A manual hand that
 * fails validation is not built (the refusal principle applies to it too).
 */

import { ParseSkip } from "../phf/detect";
import {
  draftToStandardText,
  formatHeaderDate,
  type DraftAction,
  type HandDraft,
} from "../parsers/shared/p2-handbuilder";
import { parseStandardHand } from "../phf/serialize";
import {
  CHIPS,
  EUR,
  GBP,
  USD,
  formatAmount,
  type Amount,
  type CurrencyUnit,
  type PhfHand,
} from "../phf/types";
import { validateHand, type ValidationProblem } from "../phf/validate";
import { BOARD_SIZE, type EngineState, type ManualLimit, type ManualVariant } from "./engine";
import type { ManualSettlement } from "./settle";

export const MANUAL_SITE_ID = "manual";
export const MANUAL_SITE_NAME = "Manual entry";
export const MANUAL_PARSER_VERSION = "1";

export type ManualCurrency = "USD" | "EUR" | "GBP" | "CHIPS";

export const MANUAL_UNITS: Record<ManualCurrency, CurrencyUnit> = { USD, EUR, GBP, CHIPS };

export interface ManualTournament {
  id: string;
  name: string;
  /** Buy-in and fee, minor units of `buyInCurrency`. */
  buyIn: Amount;
  fee: Amount;
  buyInCurrency: Exclude<ManualCurrency, "CHIPS">;
  /** Blind level number; 0 for none. */
  level: number;
}

/** Everything about the hand that is not betting. */
export interface ManualMeta {
  format: "cash" | "tournament";
  /** Cash games only; tournament stacks are chips. */
  currency: ManualCurrency;
  tableName: string;
  /** ISO 8601, UTC. */
  playedAt: string;
  tournament: ManualTournament | null;
  /** Stable for one hand, so saving it twice is a duplicate, not two hands. */
  handId: string;
}

export function unitFor(meta: Pick<ManualMeta, "format" | "currency">): CurrencyUnit {
  return meta.format === "tournament" ? CHIPS : MANUAL_UNITS[meta.currency];
}

export function gameLabel(variant: ManualVariant, limit: ManualLimit): string {
  const game = variant === "holdem" ? "Hold'em" : variant === "omaha" ? "Omaha" : "5 Card Omaha";
  return `${game} ${limit === "pl" ? "Pot Limit" : "No Limit"}`;
}

/** A fresh hand number: digits, time ordered, unlikely to collide. */
export function newManualHandId(now = Date.now()): string {
  return `${now}${Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, "0")}`;
}

export type BuildResult =
  | { ok: true; hand: PhfHand; warnings: ValidationProblem[] }
  | { ok: false; errors: Array<{ code: string; message: string }> };

export function buildManualDraft(
  state: EngineState,
  settlement: ManualSettlement,
  board: readonly string[],
  cardsBySeat: ReadonlyMap<number, readonly string[]>,
  meta: ManualMeta,
): HandDraft {
  const { setup } = state;
  const unit = unitFor(meta);
  const showdown = state.status.kind === "complete" && state.status.ending === "showdown";
  const reached = showdown ? 5 : Math.min(state.boardReached, BOARD_SIZE[state.street]);

  const actions: DraftAction[] = [];
  for (const entry of state.log) {
    const base = { street: entry.street, player: entry.name, allIn: entry.allIn || undefined };
    switch (entry.kind) {
      case "ante":
        actions.push({ ...base, kind: "ante", amount: entry.added });
        break;
      case "small-blind":
      case "big-blind":
      case "straddle":
        actions.push({ ...base, kind: entry.kind, amount: entry.added });
        break;
      case "fold":
      case "check":
        actions.push({ ...base, kind: entry.kind });
        break;
      case "call":
      case "bet":
      case "raise":
        actions.push({ ...base, kind: entry.kind, amount: entry.added });
        break;
    }
  }

  if (showdown) {
    const last = state.street;
    for (const player of state.players) {
      if (player.folded) continue;
      const cards = cardsBySeat.get(player.seat) ?? [];
      actions.push(
        cards.length > 0
          ? { street: last, player: player.name, kind: "show", cards: [...cards] }
          : { street: last, player: player.name, kind: "muck", cards: [] },
      );
    }
  }

  return {
    siteId: MANUAL_SITE_ID,
    siteName: MANUAL_SITE_NAME,
    parserId: MANUAL_SITE_ID,
    parserVersion: MANUAL_PARSER_VERSION,
    handPrefix: meta.format === "tournament" ? "TM" : "MH",
    handId: meta.handId,
    gameLabel: gameLabel(setup.variant, setup.limit),
    unit,
    decimals: "minimal",
    headerSmallBlind: setup.smallBlind,
    headerBigBlind: setup.bigBlind,
    tableName: meta.tableName.trim() || "Manual",
    maxSeats: setup.maxSeats,
    buttonSeat: setup.buttonSeat,
    playedAt: meta.playedAt,
    seats: state.players
      .map((player) => ({
        seat: player.seat,
        name: player.name,
        startingStack: player.startingStack,
        dealtIn: true,
        isHero: player.hero,
        dealtCards: [...(cardsBySeat.get(player.seat) ?? [])],
      }))
      .sort((a, b) => a.seat - b.seat),
    actions,
    flop: reached >= 3 ? board.slice(0, 3) : null,
    turn: reached >= 4 ? (board[3] ?? null) : null,
    river: reached >= 5 ? (board[4] ?? null) : null,
    collected: settlement.payouts.map((payout) => ({
      player: payout.name,
      amount: payout.amount,
      potName: payout.potName,
    })),
    collectedIncludesUncalled: false,
    rawText: "",
    warnings: [],
  };
}

/**
 * Standard text for a draft, adjusted for what `p2-handbuilder` does not do:
 * the tournament header, and the hero's `Dealt to` line going first (the
 * standard parser takes the first seat dealt known cards as the hero when no
 * player is literally called "Hero").
 */
export function finishText(text: string, draft: HandDraft, meta: ManualMeta): string {
  const lines = text.split("\n");
  const hero = draft.seats.find((seat) => seat.isHero);
  if (hero && hero.dealtCards.length > 0) {
    const heroLine = lines.findIndex((line) => line.startsWith(`Dealt to ${hero.name} [`));
    const marker = lines.indexOf("*** HOLE CARDS ***");
    if (heroLine > marker + 1 && marker >= 0) {
      const [line] = lines.splice(heroLine, 1);
      lines.splice(marker + 1, 0, line);
    }
  }
  if (meta.format === "tournament" && meta.tournament) {
    const t = meta.tournament;
    const unit = draft.unit;
    const buyInUnit = MANUAL_UNITS[t.buyInCurrency];
    const money = (amount: Amount) => formatAmount(amount, unit, "minimal");
    const buyIn =
      t.buyIn + t.fee > 0
        ? `${formatAmount(t.buyIn, buyInUnit, "minimal")}+${formatAmount(t.fee, buyInUnit, "minimal")} `
        : "";
    const name = t.name.trim().replace(/[()]/g, "");
    const tid = t.id.trim().replace(/[^A-Za-z0-9_-]/g, "") || draft.handId;
    const level = t.level > 0 ? `Level ${t.level} ` : "";
    lines[0] =
      `Poker Hand #${draft.handPrefix}${draft.handId}: Tournament${name ? ` (${name})` : ""} #${tid}, ` +
      `${buyIn}${draft.gameLabel} - ${level}(${money(draft.headerSmallBlind)}/${money(draft.headerBigBlind)}) - ` +
      formatHeaderDate(meta.playedAt);
  }
  return lines.join("\n");
}

/** Draft in, validated PHF out — or the reasons it was refused. */
export function buildManualHand(draft: HandDraft, meta: ManualMeta): BuildResult {
  let hand: PhfHand | null;
  try {
    const text = finishText(draftToStandardText(draft), draft, meta);
    hand = parseStandardHand(text, {
      siteId: MANUAL_SITE_ID,
      siteName: MANUAL_SITE_NAME,
      originalFilename: null,
      parserId: MANUAL_SITE_ID,
      parserVersion: MANUAL_PARSER_VERSION,
    });
    if (hand) {
      hand.meta.rawText = text;
      hand.meta.handKey = hand.meta.handId;
    }
  } catch (err) {
    if (err instanceof ParseSkip) {
      return { ok: false, errors: [{ code: err.reason, message: err.message }] };
    }
    return { ok: false, errors: [{ code: "build-failed", message: err instanceof Error ? err.message : String(err) }] };
  }
  if (!hand) {
    return { ok: false, errors: [{ code: "normalized-unparseable", message: "The hand text could not be read back." }] };
  }
  const report = validateHand(hand);
  if (!report.ok) {
    return { ok: false, errors: report.errors.map(({ code, message }) => ({ code, message })) };
  }
  return { ok: true, hand, warnings: report.warnings };
}
