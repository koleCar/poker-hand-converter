/**
 * The builder facts' catch-up after a facts version bump (docs/ANALYTICS.md
 * Step 12): once per account and page load, whichever screen asks first -
 * the shell on any signed-in page (`AppFrame`), the Hands list - counts the
 * hands without facts at `FACTS_VERSION` (`hand_facts_missing`) and, when
 * there are some, derives them (`rebuildStats`, the rebuild route). The
 * Analytics screen runs its own rebuild with its progress line.
 *
 * Meanwhile the filters keep working: the builder reads a hand's newest
 * facts row when it has none at the client's version
 * (`20271123090000_analytics_rollout_safety.sql`); only a fact the new
 * version adds (the Effective stack) waits for it.
 */

import { fetchFactsMissing, rebuildStats } from "./stats";

export interface FactsCatchUp {
  /** Hands without facts at the current version when it started. */
  missing: number;
  /** Settles when the rebuild has run (at once when nothing was missing; never rejects). */
  done: Promise<void>;
}

const started = new Map<string, Promise<FactsCatchUp>>();

/** Start (or join) this page load's catch-up for the account; never rejects. */
export function catchUpFacts(userId: string): Promise<FactsCatchUp> {
  let run = started.get(userId);
  if (!run) {
    run = fetchFactsMissing()
      .catch(() => 0)
      .then((missing) => ({
        missing,
        done: missing > 0 ? rebuildStats().then(
          () => undefined,
          () => undefined,
        ) : Promise.resolve(),
      }));
    started.set(userId, run);
  }
  return run;
}
