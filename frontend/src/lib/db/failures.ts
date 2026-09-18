/**
 * The failure corpus.
 *
 * Hands we could not convert are kept on purpose, not logged and forgotten:
 * they are the raw material for the next parser. Recording one is deliberately
 * forgiving — the server truncates over-long fields and skips malformed records
 * rather than rejecting the batch, because losing a sample we cannot reproduce
 * is worse than storing a slightly lossy one.
 */

import type { ConversionFailure } from "../phf/detect";
import { requireDb, rpc } from "./client";
import { toUnparsedHand, toUnparsedSummary } from "./mapping";
import type { RecordFailuresResult, UnparsedHand, UnparsedStatus, UnparsedSummary } from "./types";

/** Server-side cap per call. */
const MAX_FAILURES_PER_REQUEST = 200;

/**
 * Records conversion failures, deduping on `fingerprint`.
 *
 * Re-uploading the same unsupported file bumps an occurrence counter instead of
 * creating another row, so `occurrences` is a real popularity signal for
 * "which format hurts most". Never throws for an individual bad record; check
 * `result.errors` for transport-level problems and `result.skipped` for records
 * the server refused.
 */
export async function recordConversionFailures(
  failures: ConversionFailure[],
): Promise<RecordFailuresResult> {
  const result: RecordFailuresResult = {
    received: failures.length,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: [],
  };
  if (failures.length === 0) {
    return result;
  }

  for (let i = 0; i < failures.length; i += MAX_FAILURES_PER_REQUEST) {
    const batch = failures.slice(i, i + MAX_FAILURES_PER_REQUEST);
    try {
      const payload = await rpc<{ created: number; updated: number; skipped: number }>(
        "record_conversion_failures",
        { p_failures: batch },
      );
      result.created += payload.created ?? 0;
      result.updated += payload.updated ?? 0;
      result.skipped += payload.skipped ?? 0;
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error));
      result.skipped += batch.length;
    }
  }

  return result;
}

/** Aggregated view of the corpus: which site and reason to attack next. */
export async function fetchUnparsedSummary(limit = 50): Promise<UnparsedSummary> {
  const payload = await rpc<Record<string, unknown>>("unparsed_summary", { p_limit: limit });
  return toUnparsedSummary(payload);
}

export interface UnparsedQuery {
  status?: UnparsedStatus;
  detectedSite?: string;
  reason?: string;
  limit?: number;
  offset?: number;
  /** Omit the raw text, which dominates the payload, for list views. */
  withRawText?: boolean;
}

/**
 * Lists rows of the failure corpus.
 *
 * A plain PostgREST select rather than an RPC: the corpus browser is a simple
 * table view and the filters map one to one onto columns, so there is nothing
 * for a function to add.
 */
export async function listUnparsedHands(query: UnparsedQuery = {}): Promise<UnparsedHand[]> {
  const client = requireDb();
  const columns = query.withRawText
    ? "*"
    : "id,fingerprint,detected_site,detection_confidence,stage,reason,message," +
      "parser_version,source_filename,status,notes,occurrences,first_seen_at,last_seen_at";

  let request = client.from("unparsed_hands").select(columns);
  if (query.status) {
    request = request.eq("status", query.status);
  }
  if (query.detectedSite) {
    request = request.eq("detected_site", query.detectedSite);
  }
  if (query.reason) {
    request = request.eq("reason", query.reason);
  }

  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;
  const { data, error } = await request
    .order("occurrences", { ascending: false })
    .order("last_seen_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    throw new Error(error.message);
  }
  return ((data ?? []) as unknown as Record<string, unknown>[]).map((row) => ({
    ...toUnparsedHand({ raw_text: "", ...row }),
  }));
}

/** The full raw text of one corpus entry, fetched only when someone opens it. */
export async function fetchUnparsedRawText(id: string): Promise<string> {
  const client = requireDb();
  const { data, error } = await client
    .from("unparsed_hands")
    .select("raw_text")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    throw new Error(error.message);
  }
  return (data?.raw_text as string | undefined) ?? "";
}
