/**
 * Runs the account deletion to the end (Rail R6.5): the first call carries
 * the typed username; while the Edge Function answers "in progress" (a large
 * library, one call's time is up) it is called again, without it - the
 * deletion in progress is resumed on the server. Stops at the first refusal.
 *
 * The server also finishes a deletion on its own once its first steps are
 * done (pg_cron, `finish_account_deletions`), so a later call can find the
 * account already gone: "signed out" after the deletion was under way is the
 * end, not an error.
 */

import type { DeleteCallResult, DeleteErrorCode } from "../db/accountData";

export type DeletionOutcome = { status: "deleted" } | { status: "error"; code: DeleteErrorCode };

export async function runAccountDeletion(
  call: (body: { confirm?: string }) => Promise<DeleteCallResult>,
  confirm: string | null,
  onStep?: (step: string | null) => void,
  maxCalls = 500,
): Promise<DeletionOutcome> {
  let body: { confirm?: string } = confirm === null ? {} : { confirm };
  let underWay = false;
  for (let i = 0; i < maxCalls; i++) {
    const result = await call(body);
    if (result.status === "deleted") return result;
    if (result.status === "error") {
      if (underWay && result.code === "not_signed_in") return { status: "deleted" };
      return result;
    }
    underWay = true;
    onStep?.(result.step);
    body = {};
  }
  return { status: "error", code: "unavailable" };
}
