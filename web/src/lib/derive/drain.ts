/**
 * Draining the derive queue (docs/POOL.md P1): claim a page
 * (`derive_claim`), work each hand out once (`onePass.ts`), save what came
 * out (`derive_save`) and hand back what did not (`derive_fail`), until the
 * queue is empty, the time is up or the run's cap is reached.
 *
 * The same loop serves both drains: `/api/derive` with the signed-in user's
 * client (their own rows) and `/api/derive/cron` with the derive role's
 * (every owner's). Which rows a page holds is the database's decision
 * (`derive_caller`), never this code's.
 *
 * Interrupting it is harmless: a claim lapses after five minutes and the
 * rows go back to the queue; saving a hand twice adds nothing.
 */

import { ANALYSIS_VERSION } from "../analysis/types";
import { ANALYTICS_MEMBERSHIP_VERSION } from "../stats/analytics";
import type { ParseText } from "../phf/storedText";
import { passPage, type ClaimedHand, type DerivedHand, type FailedHand } from "./onePass";

/** The part of a Supabase client the drain uses. */
export interface RpcClient {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;
}

export interface DrainOptions {
  /** The text parser for text-only rows (`typescriptParser` on the server). */
  parse: ParseText;
  /** Stop claiming new pages after this long. */
  budgetMs: number;
  /** Stop after this many hands (a cron run's cap). */
  maxHands?: number;
  /** Hands per claim (`derive_claim` takes 100). */
  pageSize?: number;
  /** Hands per `derive_save` call (it takes 100). */
  saveSize?: number;
  /** For tests. */
  now?: () => number;
}

export interface DrainResult {
  /** Hands claimed and worked on. */
  processed: number;
  /** Hands saved and taken off the queue. */
  saved: number;
  /** Hands handed back (tried again later, or given up). */
  failed: number;
  /** The last claim came back short: nothing claimable is left. */
  empty: boolean;
}

/** The versions `derive_claim` reads a hand's analysis at. */
export const CLAIM_VERSIONS = { analysis: ANALYSIS_VERSION, membership: ANALYTICS_MEMBERSHIP_VERSION } as const;

class RpcError extends Error {
  code: string | undefined;
  constructor(fn: string, error: { code?: string; message: string }) {
    super(`${fn}: ${error.message}`);
    this.code = error.code;
  }
}

async function call(client: RpcClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new RpcError(fn, error);
  return data;
}

const count = (data: unknown, key: string): number => {
  const value = (data as Record<string, unknown> | null)?.[key];
  return typeof value === "number" ? value : Number(value) || 0;
};

/** Runs the drain with `client` until the queue it may see is empty, the budget is spent or the cap is reached. */
export async function drain(client: RpcClient, options: DrainOptions): Promise<DrainResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const pageSize = Math.min(Math.max(options.pageSize ?? 50, 1), 100);
  const saveSize = Math.min(Math.max(options.saveSize ?? 50, 1), 100);
  const result: DrainResult = { processed: 0, saved: 0, failed: 0, empty: false };

  while (now() - started < options.budgetMs && (options.maxHands === undefined || result.processed < options.maxHands)) {
    const limit = options.maxHands === undefined ? pageSize : Math.min(pageSize, options.maxHands - result.processed);
    const page = ((await call(client, "derive_claim", { p_limit: limit, p_versions: CLAIM_VERSIONS })) ?? []) as ClaimedHand[];
    if (page.length === 0) {
      result.empty = true;
      break;
    }
    const { derived, failed } = await passPage(page, options.parse);
    result.processed += page.length;
    for (let i = 0; i < derived.length; i += saveSize) {
      const chunk: DerivedHand[] = derived.slice(i, i + saveSize);
      const saved = await call(client, "derive_save", { p_hands: chunk });
      result.saved += count(saved, "saved");
      result.failed += count(saved, "failed");
    }
    for (let i = 0; i < failed.length; i += 100) {
      const chunk: FailedHand[] = failed.slice(i, i + 100);
      await call(client, "derive_fail", { p_hands: chunk });
      result.failed += chunk.length;
    }
    if (page.length < limit) {
      result.empty = true;
      break;
    }
  }
  return result;
}

/** The caller's hands still being processed (`derive_pending`). */
export async function pendingOf(client: RpcClient): Promise<number> {
  const data = await call(client, "derive_pending", {});
  return typeof data === "number" ? data : Number(data) || 0;
}
