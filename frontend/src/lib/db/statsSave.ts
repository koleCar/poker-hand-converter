/**
 * Writing a statistics rebuild page so that a hand the database refuses costs
 * that hand only (docs/RAIL-PLAN.md R4.4, finding F1).
 *
 * `save_hand_stats` and `save_hand_ev` are one statement per call: one row
 * that breaks a constraint refuses the whole call. The rebuild computes what
 * is missing instead of tracking it, so a refused page was refused again on
 * every later run and no hand after it ever got statistics. Here a call the
 * database refuses *for its data* (SQLSTATE class 22, data exception, or 23,
 * integrity constraint) is retried hand by hand; the hands still refused are
 * returned, counted by the route and left for the next run. Anything else -
 * the budget (53400), the session, the network - still fails the slice: it
 * says nothing about one hand, and the next call may well succeed.
 */

/** The part of a PostgREST error this needs. */
export interface SaveError {
  code?: string;
  message: string;
}

/** One RPC call with a chunk of rows: `supabase.rpc(name, { p_rows })`. */
export type SaveCall<Row> = (
  rows: Row[],
) => PromiseLike<{ data: unknown; error: SaveError | null }>;

export interface SaveOutcome {
  /** Rows the database inserted (`inserted` in the RPC's answer). */
  inserted: number;
  /** Hand keys whose rows the database refused, one call per hand. */
  refused: Set<string>;
}

/** A refusal about the rows themselves: a data exception or a broken constraint. */
export function isRowRefusal(error: SaveError): boolean {
  return typeof error.code === "string" && /^2[23]/.test(error.code);
}

/**
 * Saves `rows` in calls of at most `maxRows`, never splitting a hand across two
 * calls. Rows of a hand in `skip` are not sent (a hand whose statistics were
 * refused gets no EV row either).
 */
export async function saveRowsByHand<Row extends { hand_key: string }>(
  rows: readonly Row[],
  save: SaveCall<Row>,
  maxRows: number,
  skip: ReadonlySet<string> = new Set(),
): Promise<SaveOutcome> {
  const outcome: SaveOutcome = { inserted: 0, refused: new Set() };

  const byHand = new Map<string, Row[]>();
  for (const row of rows) {
    if (skip.has(row.hand_key)) continue;
    const group = byHand.get(row.hand_key);
    if (group) group.push(row);
    else byHand.set(row.hand_key, [row]);
  }

  // Whole hands per call, up to `maxRows` (a hand is a handful of rows).
  const chunks: Row[][][] = [];
  let current: Row[][] = [];
  let size = 0;
  for (const group of byHand.values()) {
    if (current.length > 0 && size + group.length > maxRows) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(group);
    size += group.length;
  }
  if (current.length > 0) chunks.push(current);

  const insertedOf = (data: unknown) => Number((data as { inserted?: unknown } | null)?.inserted ?? 0) || 0;

  for (const hands of chunks) {
    const { data, error } = await save(hands.flat());
    if (!error) {
      outcome.inserted += insertedOf(data);
      continue;
    }
    if (!isRowRefusal(error)) throw error;
    if (hands.length === 1) {
      outcome.refused.add(hands[0][0].hand_key);
      continue;
    }
    for (const group of hands) {
      const one = await save(group);
      if (!one.error) {
        outcome.inserted += insertedOf(one.data);
      } else if (isRowRefusal(one.error)) {
        outcome.refused.add(group[0].hand_key);
      } else {
        throw one.error;
      }
    }
  }
  return outcome;
}
