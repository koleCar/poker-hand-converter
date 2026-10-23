/**
 * Which hands of a session are worth a look (R5.1), and in which list each
 * one is shown. Pure, so the tests run it.
 *
 * Three lists, each ranked and capped:
 *
 * - **worst**: per hand its worst graded decision (Inaccurate or worse),
 *   worst grade first, then the EV it cost;
 * - **deviations**: per hand its preflop decision off the user's charts
 *   (the {@link DeviationSource}'s), the EV it cost first, then the grade;
 * - **pots**: the biggest pots, in big blinds.
 *
 * A hand is shown once, in the first of these lists it is in (this order:
 * a mistake matters more than a deviation, a deviation more than a pot's
 * size); the other lists it belongs to become badges on it, and each list
 * fills up to its cap from the hands not shown above it. The server ranks
 * the same way (`session_review`); ranking again here keeps a source that
 * does not (R5.3's own charts) and the badges' ranks right.
 */
import { gradeRank, type ReviewDecision, type ReviewHand, type ReviewPot } from "./model";

export type ReviewListKind = "worst" | "deviations" | "pots";

/** The lists in the order a hand is claimed (and shown). */
export const LIST_ORDER: readonly ReviewListKind[] = ["worst", "deviations", "pots"];

/** A list the hand is also in, and its place there (1 = first). */
export interface ReviewBadge {
  kind: ReviewListKind;
  rank: number;
}

export interface ReviewItem {
  kind: ReviewListKind;
  /** Its place in its own list, before other lists took hands (1 = first). */
  rank: number;
  handId: string;
  hand: ReviewHand | null;
  /** The decision the hand is listed for (worst, deviations). */
  decision: ReviewDecision | null;
  potBb: number | null;
  /** The other lists the hand is in. */
  badges: ReviewBadge[];
}

export interface ReviewSection {
  kind: ReviewListKind;
  items: ReviewItem[];
  /** Hands in the list before de-duplication (an empty list says so). */
  candidates: number;
  /** Of those, the hands an earlier list shows (their badge names this list). */
  shownAbove: number;
}

export interface ReviewInput {
  worst: readonly ReviewDecision[];
  deviations: readonly ReviewDecision[];
  pots: readonly ReviewPot[];
  hands: Readonly<Record<string, ReviewHand>>;
}

const playedAt = (hands: ReviewInput["hands"], handId: string): number => {
  const at = hands[handId]?.playedAt;
  const time = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
};

/** Larger first, a missing value last. */
const desc = (a: number | null, b: number | null): number => {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
};

/** Newest first, then by id: the same order on every run. */
function tieBreak(hands: ReviewInput["hands"], a: string, b: string): number {
  const time = playedAt(hands, b) - playedAt(hands, a);
  if (time !== 0 && Number.isFinite(time)) return time;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The first of each hand's entries, in the order given. */
function firstPerHand<T extends { handId: string }>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    if (seen.has(row.handId)) continue;
    seen.add(row.handId);
    out.push(row);
  }
  return out;
}

/** Worst grade first, then the EV it cost; one per hand (its worst). */
export function rankWorst(decisions: readonly ReviewDecision[], hands: ReviewInput["hands"]): ReviewDecision[] {
  const graded = decisions.filter((decision) => gradeRank(decision.grade) >= gradeRank("inaccurate"));
  return firstPerHand(
    [...graded].sort(
      (a, b) =>
        gradeRank(b.grade) - gradeRank(a.grade) ||
        desc(a.evLossBb, b.evLossBb) ||
        tieBreak(hands, a.handId, b.handId) ||
        a.ord - b.ord,
    ),
  );
}

/** The EV it cost first, then the grade; one per hand (its costliest). */
export function rankDeviations(decisions: readonly ReviewDecision[], hands: ReviewInput["hands"]): ReviewDecision[] {
  return firstPerHand(
    [...decisions].sort(
      (a, b) =>
        desc(a.evLossBb, b.evLossBb) ||
        gradeRank(b.grade) - gradeRank(a.grade) ||
        tieBreak(hands, a.handId, b.handId) ||
        a.ord - b.ord,
    ),
  );
}

/** Biggest pot first. */
export function rankPots(pots: readonly ReviewPot[], hands: ReviewInput["hands"]): ReviewPot[] {
  return firstPerHand([...pots].sort((a, b) => b.potBb - a.potBb || tieBreak(hands, a.handId, b.handId)));
}

/**
 * The three lists, each hand once: in the first list (by {@link LIST_ORDER})
 * it is in, with badges for the others, every list holding at most `cap`
 * hands not already shown above it.
 */
export function selectWorthALook(input: ReviewInput, cap: number): ReviewSection[] {
  const ranked: Record<ReviewListKind, Array<{ handId: string; decision: ReviewDecision | null; potBb: number | null }>> = {
    worst: rankWorst(input.worst, input.hands).map((decision) => ({ handId: decision.handId, decision, potBb: null })),
    deviations: rankDeviations(input.deviations, input.hands).map((decision) => ({
      handId: decision.handId,
      decision,
      potBb: null,
    })),
    pots: rankPots(input.pots, input.hands).map((pot) => ({ handId: pot.handId, decision: null, potBb: pot.potBb })),
  };

  // Every list each hand is in, with its place there.
  const memberships = new Map<string, ReviewBadge[]>();
  for (const kind of LIST_ORDER) {
    ranked[kind].forEach((entry, index) => {
      const list = memberships.get(entry.handId) ?? [];
      list.push({ kind, rank: index + 1 });
      memberships.set(entry.handId, list);
    });
  }

  const shown = new Set<string>();
  const limit = Math.max(0, Math.floor(cap));
  return LIST_ORDER.map((kind) => {
    const items: ReviewItem[] = [];
    const above = ranked[kind].filter((entry) => shown.has(entry.handId)).length;
    ranked[kind].forEach((entry, index) => {
      if (items.length >= limit || shown.has(entry.handId)) return;
      shown.add(entry.handId);
      items.push({
        kind,
        rank: index + 1,
        handId: entry.handId,
        hand: input.hands[entry.handId] ?? null,
        decision: entry.decision,
        potBb: entry.potBb ?? input.hands[entry.handId]?.potBb ?? null,
        badges: (memberships.get(entry.handId) ?? []).filter((badge) => badge.kind !== kind),
      });
    });
    return { kind, items, candidates: ranked[kind].length, shownAbove: above };
  });
}

/** bb/100 over a session, or null without hands or a result. */
export function bbPer100(netBbMilli: number | null, hands: number): number | null {
  if (netBbMilli === null || hands <= 0) return null;
  return (netBbMilli / 1000 / hands) * 100;
}

/** Whole minutes between two instants, at least one (the Sessions panel's rule). */
export function minutesBetween(start: string, end: string): number {
  return Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / 60000));
}
