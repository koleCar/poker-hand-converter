/**
 * The account's own data: export and deletion (Rail R6.5) - the client half
 * of `20271006090000_account_export.sql`, `20271006100000_account_deletion.sql`
 * and the Edge Function `account-delete`.
 *
 * Every reader is owner-only in the database (the caller's `auth.uid()`);
 * nothing here passes an account id. The deletion runs in the Edge Function
 * with the service role, invoked with the user's own session: this module
 * never holds a service key.
 */

import { requireDb, rpc } from "./client";

export type Cursor = Record<string, unknown> | null;

export interface InventoryEntry {
  name: string;
  export: "file" | "profile" | "derived" | "internal" | "on_request";
  file: string | null;
  reader: "hands" | "rows" | "sealed" | "profile" | "storage" | null;
  section: string | null;
  onDelete: "cascade" | "erase" | "anonymise" | "retain";
  note: string;
}

export interface ExportManifest {
  format: string;
  generatedAt: string;
  accountId: string;
  counts: Record<string, number>;
  uploadBytes: number;
  inventory: InventoryEntry[];
}

export interface HandsPage {
  hands: Record<string, unknown>[];
  hand_stats?: Record<string, unknown>[];
  hand_stats_ev?: Record<string, unknown>[];
  hand_analysis?: Record<string, unknown>[];
  decision_analysis?: Record<string, unknown>[];
  next: Cursor;
}

export interface RowsPage {
  rows: Record<string, unknown>[];
  next: Cursor;
}

/** What the export reads: the database through the caller's session. */
export interface ExportSource {
  manifest(): Promise<ExportManifest>;
  profile(): Promise<unknown>;
  hands(after: Cursor, limit: number, derived: boolean): Promise<HandsPage>;
  rows(reader: "rows" | "sealed", section: string, after: Cursor, limit: number): Promise<RowsPage>;
  /** A kept original file's bytes (gzip), through Storage's owner policy. */
  upload(name: string): Promise<Uint8Array>;
}

export const databaseExportSource: ExportSource = {
  manifest: () => rpc<ExportManifest>("export_my_manifest"),
  profile: () => rpc<unknown>("export_my_profile"),
  hands: (after, limit, derived) =>
    rpc<HandsPage>("export_my_hands", { p_after: after, p_limit: limit, p_derived: derived }),
  rows: (reader, section, after, limit) =>
    rpc<RowsPage>(reader === "rows" ? "export_my_rows" : "export_my_sealed", {
      p_section: section,
      p_after: after,
      p_limit: limit,
    }),
  async upload(name) {
    const { data, error } = await requireDb().storage.from("hand-uploads").download(name);
    if (error || !data) {
      throw new Error(`hand-uploads/${name}: ${error?.message ?? "no data"}`);
    }
    return new Uint8Array(await data.arrayBuffer());
  },
};

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

export type DeletionStep = "billing" | "storage" | "content" | "hands";

export interface DeletionState {
  requestedAt: string;
  updatedAt: string;
  steps: Record<DeletionStep, string | null>;
  completedAt: string | null;
  attempts: number;
  lastError: string | null;
}

/** The deletion in progress for the signed-in account, if any. */
export function myAccountDeletion(): Promise<DeletionState | null> {
  return rpc<DeletionState | null>("my_account_deletion");
}

/** The function's error codes (`supabase/functions/account-delete/handler.ts`). */
export type DeleteErrorCode =
  | "not_signed_in"
  | "invalid_request"
  | "reauth_required"
  | "confirmation_mismatch"
  | "rate_limited"
  | "billing_unavailable"
  | "unavailable";

const KNOWN: ReadonlySet<string> = new Set<DeleteErrorCode>([
  "not_signed_in",
  "invalid_request",
  "reauth_required",
  "confirmation_mismatch",
  "rate_limited",
  "billing_unavailable",
  "unavailable",
]);

export type DeleteCallResult =
  | { status: "deleted" }
  | { status: "in_progress"; step: string | null }
  | { status: "error"; code: DeleteErrorCode };

export function deleteErrorCode(value: unknown): DeleteErrorCode {
  return typeof value === "string" && KNOWN.has(value) ? (value as DeleteErrorCode) : "unavailable";
}

/** One call of the Edge Function, as the signed-in user. */
export async function callAccountDelete(body: { confirm?: string }): Promise<DeleteCallResult> {
  const client = requireDb();
  const { data, error } = await client.functions.invoke<{ status?: string; step?: string }>("account-delete", {
    body,
  });
  if (!error && data) {
    if (data.status === "deleted") return { status: "deleted" };
    if (data.status === "in_progress") return { status: "in_progress", step: data.step ?? null };
  }
  // A FunctionsHttpError carries the Response; its body names the refusal.
  const context = (error as { context?: unknown } | null)?.context;
  if (context instanceof Response) {
    try {
      const payload = (await context.json()) as { error?: unknown; status?: unknown; step?: unknown };
      if (payload.status === "in_progress") {
        return { status: "in_progress", step: typeof payload.step === "string" ? payload.step : null };
      }
      return { status: "error", code: deleteErrorCode(payload.error) };
    } catch {
      return { status: "error", code: "unavailable" };
    }
  }
  return { status: "error", code: "unavailable" };
}
