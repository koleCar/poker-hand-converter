/**
 * Where a session's training stood when the Trainer was left (#420): each
 * table's spot as it was - dealt and waiting for the answer, or answered with
 * its grade and feedback - and where "For you" was in its areas. Kept for the
 * page's (the app window's) life, so going back to the session - from the
 * Solver's "Look up in Solver", or from any other screen - continues where
 * the player stopped instead of dealing a new spot.
 *
 * A key is the session's id (and the table's index); a kept value is read
 * without being taken, and overwritten (or dropped) when its table is left
 * again.
 */

/** The most kept: a few sessions' tables. */
const MAX_KEPT = 24;

const kept = new Map<string, unknown>();

export function park(key: string, value: unknown): void {
  kept.delete(key);
  kept.set(key, value);
  while (kept.size > MAX_KEPT) {
    const oldest = kept.keys().next().value;
    if (oldest === undefined) break;
    kept.delete(oldest);
  }
}

export function parked<T>(key: string): T | null {
  return (kept.get(key) as T | undefined) ?? null;
}

export function unpark(key: string): void {
  kept.delete(key);
}
