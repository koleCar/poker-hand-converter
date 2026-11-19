/**
 * Deleting the account's own hands (`20271119200000_hand_deletion.sql`): a
 * selection, 200 a call (the server's limit), or every hand, a ~4 s step a
 * call until the server says it is done. Every summary (counts, reports,
 * analysis) stays exact on the server; published forum copies stay.
 */
import { rpc } from "./client";

/** The server takes this many ids a call. */
export const DELETE_BATCH = 200;

export interface DeleteProgress {
  deleted: number;
  total: number;
}

/** These stored hands (server ids), in batches; how many went. */
export async function deleteHands(
  ids: readonly string[],
  onProgress?: (progress: DeleteProgress) => void,
): Promise<number> {
  let deleted = 0;
  for (let start = 0; start < ids.length; start += DELETE_BATCH) {
    const batch = ids.slice(start, start + DELETE_BATCH);
    const result = await rpc<{ deleted: number }>("delete_hands", { p_ids: batch });
    deleted += result?.deleted ?? 0;
    onProgress?.({ deleted: Math.min(start + batch.length, ids.length), total: ids.length });
  }
  return deleted;
}

interface WipeStep {
  deleted: number;
  remaining: number;
  done: boolean;
}

/**
 * Every hand of the account stored up to now. `total` is what the reader
 * was told it holds (the progress' denominator); the server's `remaining`
 * corrects it as it goes.
 */
export async function deleteAllHands(total: number, onProgress?: (progress: DeleteProgress) => void): Promise<number> {
  let deleted = 0;
  // Bounded so a server that never says `done` cannot spin a tab forever:
  // 2000 steps of ~4 s are far beyond any library.
  for (let step = 0; step < 2000; step += 1) {
    const result = await rpc<WipeStep>("delete_all_hands", { p_confirm: "DELETE" });
    deleted += result?.deleted ?? 0;
    const remaining = result?.remaining ?? 0;
    onProgress?.({ deleted, total: Math.max(total, deleted + remaining) });
    if (result?.done) return deleted;
  }
  return deleted;
}

/** How many hands the account's library holds (the library's own count). */
export async function countMyHands(): Promise<number> {
  const raw = await rpc<{ library?: unknown }>("library_facets", { p_filter: {} });
  return Number(raw?.library ?? 0);
}
