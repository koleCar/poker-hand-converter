/**
 * The server's plan refusals, in one place (Rail R6.4).
 *
 * Once paid plans are enforced, a Pro function called by a Free account (or
 * a save past the Free hand cap) is refused with SQLSTATE `PT402` - HTTP
 * 402 from PostgREST (R6.2) - the feature as the hint and, for the cap, its
 * numbers as JSON detail. The screens lock what they know is Pro before
 * calling (`useEntitlements().locked`), but a refusal can still arrive: a
 * plan that ended in another tab, a direct write, a screen without a lock.
 * Every such refusal goes through here:
 *
 *  * `rpc()` (`lib/db/client.ts`) and the direct table writes (own chart
 *    sets, tournament settings) call {@link reportPlanRefusal} with the
 *    error they got;
 *  * one listener - `PlanRefusalPrompt`, mounted once in the root layout -
 *    shows the upgrade prompt and re-reads the account's entitlements.
 *
 * The bulk upload handles its own (it trims a save to the Free allowance,
 * `components/converter/bulkSaver.ts`), so it does not call this.
 *
 * Nothing here decides anything: the database is the gate.
 */

/** A `PT402` refusal, read. */
export interface PlanRefusal {
  /** The feature the server named (`analysis`, `hand_cap`, ...), or null. */
  feature: string | null;
  /** For the hand cap: the cap, the hands stored before the refused save, and how many it tried to add. */
  cap: { cap: number; stored: number; attempted: number } | null;
  /** The server's sentence (already in the reader's language when it came through `rpc()`). */
  message: string;
}

/** What a PostgREST / supabase-js error carries. */
export interface PostgrestLikeError {
  code?: string | null;
  message?: string | null;
  hint?: string | null;
  details?: string | null;
}

const FEATURE = /^[a-z_]{1,32}$/;

function capOf(details: string | null | undefined): PlanRefusal["cap"] {
  if (!details) return null;
  try {
    const value = JSON.parse(details) as Record<string, unknown>;
    const cap = value.cap;
    const stored = value.stored;
    const attempted = value.attempted;
    if ([cap, stored, attempted].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)) {
      return { cap: cap as number, stored: stored as number, attempted: attempted as number };
    }
  } catch {
    // Not JSON: no numbers.
  }
  return null;
}

/** The refusal in `error`, or null when it is not a plan refusal. */
export function planRefusalOf(error: PostgrestLikeError | null | undefined): PlanRefusal | null {
  if (!error || error.code !== "PT402") return null;
  const hint = error.hint ?? null;
  return {
    feature: hint !== null && FEATURE.test(hint) ? hint : null,
    cap: capOf(error.details),
    message: error.message ?? "",
  };
}

/** Hands a Free account may still add, from a cap refusal (0 when none). */
export function allowanceOf(refusal: PlanRefusal | null): number {
  if (!refusal?.cap) return 0;
  return Math.max(0, refusal.cap.cap - refusal.cap.stored);
}

type Listener = (refusal: PlanRefusal) => void;
const listeners = new Set<Listener>();

/** Hear every plan refusal; returns the unsubscribe. */
export function onPlanRefusal(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tell the listeners when `error` is a plan refusal. Returns the refusal (or null). */
export function reportPlanRefusal(error: PostgrestLikeError | null | undefined): PlanRefusal | null {
  const refusal = planRefusalOf(error);
  if (refusal) {
    for (const listener of [...listeners]) {
      try {
        listener(refusal);
      } catch {
        // A listener's failure is not the caller's.
      }
    }
  }
  return refusal;
}
