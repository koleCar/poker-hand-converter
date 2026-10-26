/**
 * What a tournament hand is played for (R5.5): the payout structure, the
 * players left and the stacks ICM reads - from the hand where it says, from
 * the user's settings where they gave them, assumed (and labelled) otherwise.
 *
 * **What the hand history gives.** PHF's `tournament` carries the buy-in,
 * fee, bounty, level and blinds, and (Unibet only) the stated prize pool. No
 * room in the corpus writes the payout structure, the field size or the
 * players left. The stacks at the table are exact; the rest of the field is
 * not in the hand.
 *
 * **Kind** (`tournamentKind`): PHF's `sng` / `spin` formats are taken as
 * they are; a `tournament` whose name reads like a sit-and-go (`Sit & Go`,
 * `SNG`, `Heads-up`, ACR's `Regular 9-Max`) or a spin (`Spin`, `Jackpot`,
 * `Twister`, `Expresso`, `Blast`) is assumed to be one, anything else is a
 * multi-table tournament. The user can say otherwise.
 *
 * **Payouts** (`standardPayouts`), when the user has not given them:
 *
 * | Game | Paid |
 * |---|---|
 * | spin, heads-up or 3-seat sit-and-go | winner takes all |
 * | sit-and-go of 4-6 seats | 65 / 35 |
 * | sit-and-go of 7-10 seats | 50 / 30 / 20 |
 * | multi-table (with a field size) | the top 15 %, place `p` weighted `1/p` |
 *
 * The multi-table curve is Rail's own generic one, not any room's: 1 000
 * entrants pay 150 places, first 17.9 % of the pool and the last place 1.2
 * buy-ins; 20 entrants pay 54.5 / 27.3 / 18.2.
 *
 * **Players left.** At a sit-and-go everyone left is at the table: exact. At
 * a multi-table tournament the hand does not say, so it is graded in **chip
 * EV** - what ICM reduces to far from the money - unless the user has said
 * how many were left (a point in time; later hands take the latest point at
 * or before them, an upper bound since the field only shrinks). Then the
 * players off the table are taken at the average stack (from the field size
 * and starting stack when given, else this table's average), and the model
 * is ICM when they are at most `MTT_ICM_MAX_LEFT`; a bigger field is
 * still graded in chips (`far-field`).
 *
 * Everything assumed is named in the model (`*Source`) and shown with the
 * grade; nothing assumed looks like something stated.
 */

import type { PhfHand } from "../phf/types";

export const TOURNAMENT_KINDS = ["sng", "spin", "mtt"] as const;
export type TournamentKind = (typeof TOURNAMENT_KINDS)[number];

/** A multi-table tournament is graded by ICM only with at most this many players left; more is graded in chips. */
export const MTT_ICM_MAX_LEFT = 30;
/** The share of a multi-table field the generic curve pays. */
export const MTT_PAID_SHARE = 0.15;

/** Limits the settings are held to, here and in the stores. */
export const SETTINGS_LIMITS = {
  places: 2_000,
  entrants: 1_000_000,
  startingStack: 1_000_000_000,
  checkpoints: 200,
} as const;

/**
 * What the user said about one tournament (stored per tournament, owner-only).
 * Every field optional: what is absent is assumed as above.
 */
export interface TournamentSettings {
  kind?: TournamentKind | null;
  /** Percent of the prize pool per place, first place first; non-increasing, summing to at most 100. */
  payouts?: number[] | null;
  /** The field size. */
  entrants?: number | null;
  /** Chips each entrant started with. */
  startingStack?: number | null;
  /** Players left at a point in time (ISO), as the user read it in the lobby. */
  playersLeft?: Array<{ at: string; left: number }> | null;
}

/** Settings by `tournamentKey`. */
export type TournamentSettingsMap = ReadonlyMap<string, TournamentSettings>;

/** The key settings are stored under: the room and its tournament id; null without an id. */
export function tournamentKey(hand: PhfHand): string | null {
  const id = hand.tournament?.id?.trim();
  if (!id || !hand.meta.siteId) return null;
  return `${hand.meta.siteId.toLowerCase()}:${id}`;
}

/** Why settings are refused; null when they are good. The database's guard holds the same rules. */
export function settingsProblem(settings: TournamentSettings): string | null {
  const { kind, payouts, entrants, startingStack, playersLeft } = settings;
  if (kind != null && !TOURNAMENT_KINDS.includes(kind)) return "kind";
  if (payouts != null) {
    if (!Array.isArray(payouts) || payouts.length === 0 || payouts.length > SETTINGS_LIMITS.places) return "payouts";
    let sum = 0;
    for (let p = 0; p < payouts.length; p += 1) {
      const x = payouts[p];
      if (typeof x !== "number" || !Number.isFinite(x) || x <= 0 || x > 100) return "payouts";
      if (p > 0 && x > payouts[p - 1]) return "payouts-order";
      sum += x;
    }
    if (sum > 100 + 1e-6) return "payouts-sum";
  }
  if (entrants != null && (!Number.isInteger(entrants) || entrants < 2 || entrants > SETTINGS_LIMITS.entrants)) return "entrants";
  if (startingStack != null && (!Number.isInteger(startingStack) || startingStack < 1 || startingStack > SETTINGS_LIMITS.startingStack)) {
    return "starting-stack";
  }
  if (playersLeft != null) {
    if (!Array.isArray(playersLeft) || playersLeft.length > SETTINGS_LIMITS.checkpoints) return "players-left";
    for (const point of playersLeft) {
      if (!point || typeof point.at !== "string" || Number.isNaN(Date.parse(point.at))) return "players-left";
      if (!Number.isInteger(point.left) || point.left < 2 || point.left > (entrants ?? SETTINGS_LIMITS.entrants)) return "players-left";
    }
  }
  if (payouts != null && entrants != null && payouts.length > entrants) return "payouts-places";
  return null;
}

/* ---------------------------------------------------------------- kinds - */

const SPIN_NAME = /\b(spin|jackpot|twister|expresso|blast|lottery)\b/i;
const SNG_NAME = /\b(sit\s*(?:&|n|and)?\s*go|sng|s&g|heads[\s-]?up|hu|\d{1,2}[\s-]?max)\b/i;
const MTT_NAME = /\b(gtd|guaranteed?|freeroll|series|main event|satellite|sat|daily|sunday|bounty hunters)\b/i;

export type KindSource = "phf" | "name" | "assumed" | "user";

/** The tournament's kind as the hand tells it, and how it was told. */
export function tournamentKind(hand: PhfHand, settings?: TournamentSettings | null): { kind: TournamentKind; source: KindSource } {
  if (settings?.kind) return { kind: settings.kind, source: "user" };
  if (hand.game.format === "sng") return { kind: "sng", source: "phf" };
  if (hand.game.format === "spin") return { kind: "spin", source: "phf" };
  const name = hand.tournament?.name ?? "";
  if (SPIN_NAME.test(name)) return { kind: "spin", source: "name" };
  if (SNG_NAME.test(name) && !MTT_NAME.test(name) && hand.table.maxSeats <= 10) return { kind: "sng", source: "name" };
  return { kind: "mtt", source: "assumed" };
}

/* -------------------------------------------------------------- payouts - */

/** Rail's generic multi-table curve: the top 15 % of `entrants` (at least one), place `p` weighted `1/p`, in percent. */
export function mttPayouts(entrants: number): number[] {
  const paid = Math.max(1, Math.floor(entrants * MTT_PAID_SHARE));
  let total = 0;
  for (let p = 1; p <= paid; p += 1) total += 1 / p;
  const out: number[] = [];
  for (let p = 1; p <= paid; p += 1) out.push((100 / p) / total);
  return out;
}

/** The structure assumed for a kind of game when the user has not given one, in percent; null when there is none to assume. */
export function standardPayouts(kind: TournamentKind, seats: number, entrants: number | null): number[] | null {
  if (kind === "spin") return [100];
  if (kind === "sng") {
    if (seats <= 3) return [100];
    if (seats <= 6) return [65, 35];
    if (seats <= 10) return [50, 30, 20];
    return mttPayouts(entrants ?? seats);
  }
  return entrants === null ? null : mttPayouts(entrants);
}

/* ---------------------------------------------------------------- model - */

/** Why a hand is graded in chips rather than by ICM. */
export type ChipsReason =
  /** A multi-table tournament whose players left nobody gave. */
  | "players-left-unknown"
  /** A multi-table tournament without a payout structure or a field size to assume one from. */
  | "payouts-unknown"
  /** More than `MTT_ICM_MAX_LEFT` players left. */
  | "far-field";

export interface TournamentModel {
  /** `tournamentKey`, or null without an id (nothing can be stored for it). */
  key: string | null;
  kind: TournamentKind;
  kindSource: KindSource;
  /** Percent of the prize pool per place, as used; null in chips without a structure. */
  payouts: number[] | null;
  payoutsSource: "standard" | "user" | null;
  entrants: number | null;
  entrantsSource: "assumed" | "user" | null;
  /** Players left in the tournament at this hand; null when unknown. */
  playersLeft: number | null;
  playersLeftSource: "table" | "user" | null;
  /** `icm`: prize equity; `chips`: chip EV (`chipsReason`). */
  model: "icm" | "chips";
  chipsReason: ChipsReason | null;
  /** Stacks of the players left who are not at this table, each at the average (ICM only). */
  others: { count: number; stack: number; source: "field" | "table" } | null;
  /** The prize pool in `buyInUnit` minor units, when stated or computable; null otherwise. */
  prizePool: { amount: number; source: "phf" | "buy-ins" } | null;
}

/** The latest point at or before `playedAt`; none before the first or without a time. */
function leftAt(points: ReadonlyArray<{ at: string; left: number }> | null | undefined, playedAt: string | null): number | null {
  if (!points || points.length === 0 || !playedAt) return null;
  const t = Date.parse(playedAt);
  if (Number.isNaN(t)) return null;
  let best: { at: number; left: number } | null = null;
  for (const point of points) {
    const at = Date.parse(point.at);
    if (Number.isNaN(at) || at > t) continue;
    if (!best || at > best.at || (at === best.at && point.left < best.left)) best = { at, left: point.left };
  }
  return best?.left ?? null;
}

/** The players with chips at the start of the hand (dealt in or sitting out): everyone ICM counts at this table. */
export function tableStacks(hand: PhfHand): Array<{ seat: number; stack: number }> {
  return hand.players.filter((p) => p.startingStack > 0).map((p) => ({ seat: p.seat, stack: p.startingStack }));
}

/**
 * The tournament model of one hand: the payouts, players left and stacks
 * its decisions are graded with, each with where it came from. `settings`
 * are the user's for this tournament (`tournamentKey`), if any; invalid ones
 * are ignored as a whole.
 */
export function tournamentModel(hand: PhfHand, given?: TournamentSettings | null): TournamentModel {
  const settings = given && settingsProblem(given) === null ? given : null;
  const { kind, source: kindSource } = tournamentKind(hand, settings);
  const table = tableStacks(hand);
  const seated = table.length;
  const tableChips = table.reduce((sum, p) => sum + p.stack, 0);
  const t = hand.tournament;

  // The field: the user's, or a sit-and-go's own seats.
  const entrants = settings?.entrants ?? (kind === "mtt" ? null : Math.max(hand.table.maxSeats, seated));
  const entrantsSource = settings?.entrants ? "user" : entrants !== null ? "assumed" : null;

  const userPayouts = settings?.payouts ?? null;
  const payouts = userPayouts ?? standardPayouts(kind, hand.table.maxSeats, entrants);
  const payoutsSource = userPayouts ? "user" : payouts ? "standard" : null;

  const stated = t?.prizePool;
  const prizePool =
    typeof stated === "number" && stated > 0
      ? { amount: stated, source: "phf" as const }
      : t && t.buyIn > 0 && entrants !== null && kind !== "spin"
        ? { amount: t.buyIn * entrants, source: "buy-ins" as const }
        : null;

  const base = { key: tournamentKey(hand), kind, kindSource, payouts, payoutsSource, entrants, entrantsSource, prizePool } as const;

  if (kind !== "mtt") {
    return { ...base, playersLeft: seated, playersLeftSource: "table", model: payouts ? "icm" : "chips", chipsReason: payouts ? null : "payouts-unknown", others: null };
  }
  const said = leftAt(settings?.playersLeft, hand.playedAt);
  const playersLeft = said === null ? null : Math.max(said, seated);
  if (playersLeft === null) {
    return { ...base, playersLeft: null, playersLeftSource: null, model: "chips", chipsReason: "players-left-unknown", others: null };
  }
  if (!payouts) {
    return { ...base, playersLeft, playersLeftSource: "user", model: "chips", chipsReason: "payouts-unknown", others: null };
  }
  if (playersLeft > MTT_ICM_MAX_LEFT) {
    return { ...base, playersLeft, playersLeftSource: "user", model: "chips", chipsReason: "far-field", others: null };
  }
  let others: TournamentModel["others"] = null;
  const away = playersLeft - seated;
  if (away > 0) {
    const field = settings?.entrants && settings?.startingStack ? settings.entrants * settings.startingStack : null;
    const fromField = field !== null && field - tableChips > 0 ? (field - tableChips) / away : null;
    others =
      fromField !== null
        ? { count: away, stack: fromField, source: "field" }
        : { count: away, stack: seated > 0 ? tableChips / seated : 1, source: "table" };
  }
  return { ...base, playersLeft, playersLeftSource: "user", model: "icm", chipsReason: null, others };
}

/**
 * The prizes ICM distributes among the players left, as fractions of the
 * whole pool: places 1..`left` of the structure (the places below were paid
 * to those already out). Empty in chips.
 */
export function remainingPrizes(model: TournamentModel): number[] {
  if (model.model !== "icm" || !model.payouts || model.playersLeft === null) return [];
  return model.payouts.slice(0, model.playersLeft).map((percent) => percent / 100);
}
