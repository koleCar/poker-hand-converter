/**
 * The converter's bulk save (R4.2): the calls, and what their failures mean.
 *
 * ## Where converted hands go
 *
 * Through `ingest_hands` - the desktop app's path since R1.8 - from the
 * account's one **web hand source** (`hand_sources.kind = 'web'`, which R1.8
 * created for this step; `register_web_hand_source()` returns it). Not through
 * `save_hands`, for three reasons a desktop-sized upload makes concrete:
 *
 *  * **Budget.** `save_hands` spends the web's *global* budget (25 000 rows
 *    per 10 minutes for every account together): a 1M-hand upload would need
 *    seven hours and lock every other user out meanwhile. `ingest_hands`
 *    charges the account's own budget (150 000 / 10 min, 2 000 000 / day).
 *  * **Size, and A2.** A `save_hands` row carries the original text twice
 *    (`source_text`, and the PHF's `meta.rawText`) and the standard text,
 *    ~7.3 KB a hand; an ingested row is the PHF alone (~2.9 KB) and its
 *    columns are derived on the server (A5, Q4). The original text leaves
 *    the tab only when the user opts in to keeping the files (below).
 *  * **Parity.** The same hand from the app and from the web is the same row
 *    (R4.4).
 *
 * Rows written this way carry `origin = 'upload'` (migration
 * 20270609090000): the PHF-only shape of a desktop row, written from the web.
 * Insert-only as everywhere: `on conflict (owner_id, hand_key) do nothing`, so
 * a repeat of the same file inserts nothing and is counted as duplicates.
 *
 * ## Originals (A2: opt-in)
 *
 * When - and only when - the user ticks "keep the original files", each file
 * that decoded goes gzip-compressed to the private bucket `hand-uploads`
 * under `<uid>/<upload id>/...`. The bucket's policies (same migration) let
 * an account read, write and delete only under its own uid.
 */

import { planRefusalOf, type PlanRefusal } from "../entitlements/planRefusal";
import type { ConversionFailure } from "../phf/detect";

/** The private bucket for originals the user chose to keep. */
export const UPLOAD_BUCKET = "hand-uploads";

/** One row for `ingest_hands`. */
export interface IngestRow {
  hand_key: string;
  phf: unknown;
}

/** Per-row outcome, in input order. */
export interface IngestRowResult {
  handKey: string | null;
  status: "inserted" | "duplicate" | "rejected";
  reason?: string;
  field?: string;
}

export interface IngestReport {
  received: number;
  inserted: number;
  duplicates: number;
  rejected: number;
  rows: IngestRowResult[];
}

/** What a failed call means for the upload. */
export type UploadErrorKind =
  /** No session, or the server ended it: pause until the user signs in. */
  | "signed-out"
  /** The account's 10-minute budget is spent: wait, then send again. */
  | "rate-limited"
  /** The account's daily budget is spent: pause; resume tomorrow. */
  | "rate-limited-day"
  /** The web source is gone (or not this account's): register it again. */
  | "unknown-source"
  /** The server refused the call itself - a bug; do not resend it. */
  | "refused"
  /**
   * (R6.4) The account's plan refused it (`PT402`, HTTP 402, R6.2): the Free
   * hand cap (the whole statement; `refusal.cap` has the numbers), or a Pro
   * feature. Resending the same call cannot help.
   */
  | "plan"
  /** No answer, a timeout, a 5xx: retry with backoff. */
  | "transient";

export class UploadError extends Error {
  readonly kind: UploadErrorKind;
  /** (R6.4) For `plan`: what the server said (the feature, the cap's numbers). */
  readonly refusal: PlanRefusal | null;
  constructor(kind: UploadErrorKind, message: string, refusal: PlanRefusal | null = null) {
    super(message);
    this.name = "UploadError";
    this.kind = kind;
    this.refusal = refusal;
  }
}

/**
 * Sorts a PostgREST or Storage failure the way the desktop's sync does
 * (`rail-sync`'s `error_of`): the Postgres code first, then the HTTP status.
 */
export function classifyFailure(code: string | null | undefined, status: number | null | undefined, message: string): UploadErrorKind {
  const c = code ?? "";
  const s = status ?? 0;
  if (c === "PT402" || s === 402) {
    return "plan";
  }
  if (c === "53400") {
    return /_day:/.test(message) ? "rate-limited-day" : "rate-limited";
  }
  if (c === "42501" || c === "PGRST301" || c === "PGRST303" || s === 401) {
    return "signed-out";
  }
  if (c === "23503") {
    return "unknown-source";
  }
  if (c === "57014" || c === "40001" || c === "40P01" || s === 0 || s === 408 || s === 429 || s >= 500) {
    return "transient";
  }
  if (s >= 400 && s < 500) {
    return "refused";
  }
  // No status and no code we know: a fetch that never got an answer.
  return c ? "refused" : "transient";
}

/** The calls the bulk save makes. A fake implements this in the tests. */
export interface UploadApi {
  /** The signed-in user's id, or null. */
  userId(): Promise<string | null>;
  /** The account's web hand source (created on first use). */
  registerWebSource(): Promise<string>;
  ingest(source: string, rows: IngestRow[]): Promise<IngestReport>;
  /** Stores one original; "exists" when an earlier attempt already did. */
  storeOriginal(path: string, blob: Blob): Promise<"stored" | "exists">;
  /** Best effort: the failure corpus (`record_conversion_failures`). */
  recordFailures(failures: ConversionFailure[]): Promise<{ created: number; updated: number }>;
}

/** The slice of the Supabase client the bulk save uses. */
export interface UploadClient {
  auth: { getSession(): Promise<{ data: { session: { user?: { id?: string } } | null } }> };
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{
    data: unknown;
    error: RpcFailure | null;
    status?: number;
  }>;
  storage: {
    from(bucket: string): {
      upload(path: string, body: Blob, options: { contentType: string; upsert: boolean; cacheControl?: string }): Promise<{
        data: unknown;
        error: (Error & { status?: number; statusCode?: string | number }) | null;
      }>;
    };
  };
}

/** A PostgREST error as supabase-js hands it over. */
interface RpcFailure {
  message: string;
  code?: string | null;
  hint?: string | null;
  details?: string | null;
}

function rpcError(fn: string, error: RpcFailure, status: number | undefined): UploadError {
  const kind = classifyFailure(error.code, status, error.message);
  const refusal = kind === "plan" ? (planRefusalOf({ ...error, code: "PT402" }) ?? null) : null;
  return new UploadError(kind, `${fn}: ${error.message}`, refusal);
}

/** {@link UploadApi} over a Supabase client (the tab's own; never a service key). */
export function createUploadApi(client: UploadClient): UploadApi {
  return {
    async userId() {
      const { data } = await client.auth.getSession();
      return data.session?.user?.id ?? null;
    },

    async registerWebSource() {
      let response;
      try {
        response = await client.rpc("register_web_hand_source", {});
      } catch (error) {
        throw new UploadError("transient", error instanceof Error ? error.message : String(error));
      }
      if (response.error) {
        throw rpcError("register_web_hand_source", response.error, response.status);
      }
      if (typeof response.data !== "string") {
        throw new UploadError("refused", "register_web_hand_source returned no id");
      }
      return response.data;
    },

    async ingest(source, rows) {
      let response;
      try {
        response = await client.rpc("ingest_hands", { p_source: source, p_rows: rows });
      } catch (error) {
        throw new UploadError("transient", error instanceof Error ? error.message : String(error));
      }
      if (response.error) {
        throw rpcError("ingest_hands", response.error, response.status);
      }
      const report = response.data as Partial<IngestReport> | null;
      if (!report || !Array.isArray(report.rows)) {
        throw new UploadError("transient", "ingest_hands: unreadable answer");
      }
      return {
        received: report.received ?? rows.length,
        inserted: report.inserted ?? 0,
        duplicates: report.duplicates ?? 0,
        rejected: report.rejected ?? 0,
        rows: report.rows,
      };
    },

    async storeOriginal(path, blob) {
      // storage-js sends a Blob as multipart form data with the Blob's own
      // type, not `contentType`; an untyped Blob arrives as
      // application/octet-stream, which the bucket refuses. (Found against a
      // local stack; wrapping copies no bytes.)
      const body = blob.type === "application/gzip" ? blob : new Blob([blob], { type: "application/gzip" });
      let response;
      try {
        response = await client.storage
          .from(UPLOAD_BUCKET)
          .upload(path, body, { contentType: "application/gzip", upsert: false, cacheControl: "3600" });
      } catch (error) {
        throw new UploadError("transient", error instanceof Error ? error.message : String(error));
      }
      const error = response.error;
      if (!error) {
        return "stored";
      }
      const statusCode = Number(error.statusCode ?? error.status ?? 0);
      // A resumed upload sends a file the first attempt stored: the object is
      // there, which is all that was wanted. (Storage answers 409, or 400 with
      // statusCode "409", depending on its version.)
      if (statusCode === 409 || /already exists|duplicate/i.test(error.message)) {
        return "exists";
      }
      const kind = statusCode === 413
        ? "refused"
        : classifyFailure(null, statusCode || (error.name === "StorageUnknownError" ? 0 : 400), error.message);
      throw new UploadError(kind, `storage: ${error.message}`);
    },

    async recordFailures(failures) {
      if (failures.length === 0) {
        return { created: 0, updated: 0 };
      }
      const response = await client.rpc("record_conversion_failures", { p_failures: failures });
      if (response.error) {
        throw rpcError("record_conversion_failures", response.error, response.status);
      }
      const payload = (response.data ?? {}) as { created?: number; updated?: number };
      return { created: payload.created ?? 0, updated: payload.updated ?? 0 };
    },
  };
}
