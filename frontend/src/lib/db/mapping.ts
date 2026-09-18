/**
 * Translation between PHF / the wire format and the camelCase types this module
 * exposes.
 *
 * The `hands` table is a denormalized projection of PHF: every column here is
 * derivable from the document, and it exists only because you cannot index
 * inside a `jsonb` blob usefully. If you add a search column, add it here too —
 * this file is the single definition of "what the row means".
 */

import { handClass } from "../cards";
import {
  formatAmount,
  heroOf,
  primaryBoard,
  totalFees,
  type PhfHand,
} from "../phf/types";
import type {
  GameFormat,
  HandRecord,
  HandSummary,
  StreetReached,
  UnparsedGap,
  UnparsedHand,
  UnparsedSummary,
} from "./types";

/** The snake_case row shape the `save_hands` RPC accepts. */
export interface HandInsert {
  hand_key: string;
  phf: PhfHand;
  standard_text: string;
  source_text: string | null;
  schema_version: string;
  parser_version: string | null;
  site: string;
  site_hand_id: string | null;
  variant: string | null;
  limit_type: string | null;
  game_format: GameFormat;
  tournament_id: string | null;
  currency: string;
  currency_minor_units: number;
  currency_symbol: string | null;
  small_blind: number | null;
  big_blind: number | null;
  ante: number | null;
  stakes_label: string | null;
  table_name: string | null;
  max_seats: number | null;
  played_at: string | null;
  hero_name: string | null;
  hero_seat: number | null;
  hero_position: string | null;
  hero_cards: string[];
  hero_hand_class: string | null;
  board_cards: string[];
  player_names: string[];
  player_count: number;
  street_reached: StreetReached | null;
  went_to_showdown: boolean;
  total_pot: number | null;
  rake: number | null;
  hero_profit: number | null;
  winners: string[];
  source_filename: string | null;
}

/**
 * Dedupe key for a hand.
 *
 * `PhfMeta.handKey` is only unique within a site (it is usually the site's own
 * hand id), so the site prefix is what makes it globally safe. Exported because
 * callers sometimes need to know the key before they save — for example to tell
 * a user "you already have this hand".
 */
export function handKeyOf(hand: PhfHand): string {
  const site = hand.meta.siteId.trim().toLowerCase();
  const key = hand.meta.handKey || hand.meta.handId;
  return `${site}:${key}`;
}

/** Pre-rendered "$0.50/$1", or null when the blinds are unknown. */
function stakesLabelOf(hand: PhfHand): string | null {
  const { smallBlind, bigBlind, unit } = hand.game;
  if (!smallBlind && !bigBlind) {
    return null;
  }
  const style = hand.meta.textStyle.decimals;
  return `${formatAmount(smallBlind, unit, style)}/${formatAmount(bigBlind, unit, style)}`;
}

/**
 * PHF document plus its rendered standard text into a row for `save_hands`.
 *
 * `standardText` is passed in rather than computed here so a caller that
 * already serialized the hand for download does not pay for it twice.
 */
export function handInsertFromPhf(hand: PhfHand, standardText: string): HandInsert {
  const hero = heroOf(hand);
  const unit = hand.game.unit;
  const winners = Array.from(new Set(hand.results.winners.map((winner) => winner.player)));

  return {
    hand_key: handKeyOf(hand),
    phf: hand,
    standard_text: standardText,
    source_text: hand.meta.rawText || null,
    schema_version: hand.schema,
    parser_version: hand.meta.parserVersion || null,

    site: hand.meta.siteId,
    site_hand_id: hand.meta.handId || null,
    variant: hand.game.variant,
    limit_type: hand.game.limit,
    game_format: hand.game.format,
    tournament_id: hand.tournament?.id ?? null,

    currency: unit.code,
    currency_minor_units: unit.minorUnits,
    currency_symbol: unit.symbol,

    small_blind: hand.game.smallBlind,
    big_blind: hand.game.bigBlind,
    ante: hand.game.ante || null,
    stakes_label: stakesLabelOf(hand),

    table_name: hand.table.name,
    max_seats: hand.table.maxSeats || null,
    played_at: hand.playedAt,

    hero_name: hero?.name ?? null,
    hero_seat: hero?.seat ?? null,
    hero_position: hero?.position ?? null,
    hero_cards: hero?.holeCards ?? [],
    hero_hand_class: hero ? handClass(hero.holeCards) : null,

    // Primary runout only. A run-it-twice second board is still in `phf`; the
    // search column would otherwise make "board contains Ah" match a card that
    // only ever appeared on the second run.
    board_cards: primaryBoard(hand),
    player_names: hand.players.map((player) => player.name),
    player_count: hand.players.length,

    street_reached: hand.results.streetReached,
    went_to_showdown: hand.results.wentToShowdown,
    total_pot: hand.results.totalPot,
    // Every fee the site took out of the pot, not just the line item called
    // "rake"; the breakdown stays available in `phf.results.fees`.
    rake: totalFees(hand.results.fees),
    hero_profit: hand.results.heroNet,
    winners,

    source_filename: hand.meta.originalFilename,
  };
}

/* ------------------------------------------------------- wire -> client - */

type Row = Record<string, unknown>;

const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const list = (value: unknown): string[] => (Array.isArray(value) ? (value as string[]) : []);

export function toHandSummary(row: Row): HandSummary {
  return {
    id: String(row.id),
    handKey: String(row.hand_key),
    site: String(row.site),
    siteHandId: str(row.site_hand_id),
    variant: str(row.variant),
    limitType: str(row.limit_type),
    gameFormat: (str(row.game_format) ?? "cash") as GameFormat,
    tournamentId: str(row.tournament_id),

    currency: String(row.currency ?? "USD"),
    currencyMinorUnits: num(row.currency_minor_units) ?? 100,
    currencySymbol: typeof row.currency_symbol === "string" ? row.currency_symbol : null,

    smallBlind: num(row.small_blind),
    bigBlind: num(row.big_blind),
    ante: num(row.ante),
    stakesLabel: str(row.stakes_label),

    tableName: str(row.table_name),
    maxSeats: num(row.max_seats),
    playedAt: str(row.played_at),

    heroName: str(row.hero_name),
    heroSeat: num(row.hero_seat),
    heroPosition: str(row.hero_position),
    heroCards: list(row.hero_cards),
    heroHandClass: str(row.hero_hand_class),

    boardCards: list(row.board_cards),
    playerNames: list(row.player_names),
    playerCount: num(row.player_count),

    streetReached: str(row.street_reached) as StreetReached | null,
    wentToShowdown: row.went_to_showdown === true,
    totalPot: num(row.total_pot),
    rake: num(row.rake),
    heroProfit: num(row.hero_profit),
    winners: list(row.winners),

    schemaVersion: String(row.schema_version ?? "phf/1"),
    parserVersion: str(row.parser_version),
    sourceFilename: str(row.source_filename),
    createdAt: String(row.created_at),
  };
}

export function toHandRecord(row: Row): HandRecord {
  return {
    ...toHandSummary(row),
    phf: row.phf as PhfHand,
    standardText: String(row.standard_text ?? ""),
    sourceText: str(row.source_text),
  };
}

export function toUnparsedHand(row: Row): UnparsedHand {
  return {
    id: String(row.id),
    fingerprint: String(row.fingerprint),
    rawText: String(row.raw_text ?? ""),
    detectedSite: str(row.detected_site),
    detectionConfidence: num(row.detection_confidence),
    stage: String(row.stage) as UnparsedHand["stage"],
    reason: String(row.reason),
    message: String(row.message),
    parserVersion: String(row.parser_version),
    sourceFilename: str(row.source_filename),
    status: String(row.status) as UnparsedHand["status"],
    notes: str(row.notes),
    occurrences: num(row.occurrences) ?? 1,
    firstSeenAt: String(row.first_seen_at),
    lastSeenAt: String(row.last_seen_at),
  };
}

export function toUnparsedGap(row: Row): UnparsedGap {
  return {
    detectedSite: String(row.detected_site ?? "(unknown)"),
    stage: String(row.stage) as UnparsedGap["stage"],
    reason: String(row.reason),
    status: String(row.status) as UnparsedGap["status"],
    distinctHands: num(row.distinct_hands) ?? 0,
    totalOccurrences: num(row.total_occurrences) ?? 0,
    firstSeenAt: String(row.first_seen_at),
    lastSeenAt: String(row.last_seen_at),
  };
}

export function toUnparsedSummary(payload: Row): UnparsedSummary {
  const gaps = Array.isArray(payload.gaps) ? (payload.gaps as Row[]) : [];
  return {
    total: num(payload.total) ?? 0,
    occurrences: num(payload.occurrences) ?? 0,
    byStatus: (payload.byStatus ?? {}) as UnparsedSummary["byStatus"],
    gaps: gaps.map(toUnparsedGap),
  };
}
