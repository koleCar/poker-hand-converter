/**
 * The Analysis tab's Multiway and Bomb pots pages (analysis/45), read from
 * Supabase (`20271119230000_analysis_pot_kinds.sql`); the app reads the same
 * from its store (rail-store `pot_kinds.rs`). The bomb pots are summed in the
 * browser from the hands themselves (`bombSummary`).
 */

import type { BombSummary, MultiwaySummary, PotKind, PotKindDecision } from "@rail/ui/potKinds/model";

import { ANALYSIS_VERSION } from "../analysis/types";
import { bombSummary } from "../analysis/potKinds";
import type { PhfHand } from "../phf/types";
import { STATS_VERSION } from "../stats";
import { rpc } from "./client";
import { handOfRow, type StoredHandRow } from "./storedHand";

/** Bomb pots read at most (newest first): enough for every sum the page shows. */
const MAX_BOMB_HANDS = 5_000;
const PAGE = 500;

/** The reader's cash bomb pots summed, newest `MAX_BOMB_HANDS` of them. */
export async function fetchBombSummary(): Promise<BombSummary> {
  const hands: PhfHand[] = [];
  let beforePlayed: string | null = null;
  let beforeId: string | null = null;
  for (let read = 0; read < MAX_BOMB_HANDS; read += PAGE) {
    type Row = StoredHandRow & { id: string; played_at: string | null };
    const page: Row[] | null = await rpc("analysis_bomb_hands", {
      p_stats_version: STATS_VERSION,
      p_before_played: beforePlayed ?? undefined,
      p_before_id: beforeId ?? undefined,
      p_limit: PAGE,
    });
    const rows: Row[] = page ?? [];
    const parsed = await Promise.all(rows.map((row) => handOfRow(row)));
    for (const hand of parsed) if (hand) hands.push(hand);
    if (rows.length < PAGE) break;
    beforePlayed = rows[rows.length - 1].played_at;
    beforeId = rows[rows.length - 1].id;
  }
  return bombSummary(hands);
}

interface MultiwayRow {
  hands: number;
  netBbMilli: number;
  showdownBbMilli: number;
  nonShowdownBbMilli: number;
  byPlayers: (MultiwaySummary["byPlayers"][number] & { grades: number[] })[];
}

/** The reader's multiway hands' sums (cash, the current analysis). */
export async function fetchMultiwaySummary(): Promise<MultiwaySummary> {
  const row: MultiwayRow | null = await rpc("analysis_multiway_summary", {
    p_version: ANALYSIS_VERSION,
    p_stats_version: STATS_VERSION,
  });
  const byPlayers = row?.byPlayers ?? [];
  const grades = [0, 0, 0, 0, 0];
  for (const p of byPlayers) p.grades.forEach((n, i) => (grades[i] += Number(n) || 0));
  return {
    hands: Number(row?.hands ?? 0),
    netBbMilli: Number(row?.netBbMilli ?? 0),
    showdownBbMilli: Number(row?.showdownBbMilli ?? 0),
    nonShowdownBbMilli: Number(row?.nonShowdownBbMilli ?? 0),
    decisions: byPlayers.reduce((sum, p) => sum + Number(p.decisions), 0),
    graded: byPlayers.reduce((sum, p) => sum + Number(p.graded), 0),
    grades,
    byPlayers: byPlayers.map((p) => ({
      players: Number(p.players),
      decisions: Number(p.decisions),
      graded: Number(p.graded),
      off: Number(p.off),
      evLossBb: Number(p.evLossBb),
    })),
  };
}

/** One pot kind's decisions graded Inaccurate or worse, most EV lost first. */
export async function fetchPotKindDecisions(kind: PotKind, limit = 12): Promise<PotKindDecision[]> {
  const rows: PotKindDecision[] | null = await rpc("analysis_pot_kind_decisions", {
    p_version: ANALYSIS_VERSION,
    p_kind: kind,
    p_limit: limit,
  });
  return (rows ?? []).map((r) => ({ ...r, evLossBb: Number(r.evLossBb) }));
}
