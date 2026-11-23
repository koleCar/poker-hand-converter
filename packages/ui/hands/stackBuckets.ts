/**
 * Stack depth buckets, the one definition (docs/ANALYTICS.md Step 11):
 * `config/stats/stack-buckets.json`, copied here as data
 * (`tests/test/stackBuckets.test.ts` fails when the two differ; Rust reads
 * the file itself, `rail_stats::stack_buckets`, and SQL a function generated
 * from it, `rail_stack_bucket`).
 *
 * - `filter`: the Hands filter's Stack (the hero's starting stack) and
 *   Effective stack (at the hero's first preflop action) chips.
 * - `breakdown`: the Analytics Breakdown tab's Stack split (the hero's
 *   starting stack).
 *
 * A bucket runs from its `min` (tenths of a big blind, inclusive) to the
 * next one's (exclusive); the last has no end.
 */

export interface StackBucket {
  id: string;
  /** Tenths of a big blind, inclusive. */
  min: number;
}

export type StackScheme = "filter" | "breakdown";

export const STACK_BUCKETS: Record<StackScheme, readonly StackBucket[]> = {
  filter: [
    { id: "0-40", min: 0 },
    { id: "40-80", min: 400 },
    { id: "80-120", min: 800 },
    { id: "120+", min: 1200 },
  ],
  breakdown: [
    { id: "0-20", min: 0 },
    { id: "20-40", min: 200 },
    { id: "40-70", min: 400 },
    { id: "70-100", min: 700 },
    { id: "100-150", min: 1000 },
    { id: "150-250", min: 1500 },
    { id: "250+", min: 2500 },
  ],
};

/** A scheme's ids, lowest first. */
export function stackOrder(scheme: StackScheme): string[] {
  return STACK_BUCKETS[scheme].map((bucket) => bucket.id);
}

/** The bucket of a stack in tenths of a big blind; null below the first (a negative stack). */
export function stackBucketOf(scheme: StackScheme, tenths: number): string | null {
  let out: string | null = null;
  for (const bucket of STACK_BUCKETS[scheme]) {
    if (tenths >= bucket.min) out = bucket.id;
  }
  return out;
}
