/**
 * Sends a feedback report to the Edge Function `feedback`
 * (`supabase/functions/feedback/handler.ts`). `functions.invoke` carries the
 * session's token when signed in (the report then carries the account) and
 * the anon key otherwise (a visitor's report).
 */

import type { FeedbackDraft, FeedbackError } from "@rail/ui/feedback/FeedbackDialog";
import { requireDb } from "./client";

const KNOWN: ReadonlySet<string> = new Set<FeedbackError>([
  "invalid_request",
  "too_large",
  "rate_limited",
  "unavailable",
]);

/** Null when stored, else why not. */
export async function sendFeedback(draft: FeedbackDraft, context: { page: string; locale: string }): Promise<FeedbackError | null> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return "offline";
  }
  const client = requireDb();
  const { error } = await client.functions.invoke("feedback", {
    body: {
      kind: draft.kind,
      message: draft.message,
      email: draft.email,
      website: draft.website,
      images: draft.images.map((data) => ({ data })),
      source: "web",
      page: context.page,
      platform: typeof navigator === "undefined" ? null : navigator.userAgent.slice(0, 300),
      locale: context.locale,
    },
  });
  if (!error) return null;
  const response = (error as { context?: unknown }).context;
  if (response instanceof Response) {
    try {
      const payload = (await response.json()) as { error?: unknown };
      return typeof payload.error === "string" && KNOWN.has(payload.error) ? (payload.error as FeedbackError) : "unavailable";
    } catch {
      return "unavailable";
    }
  }
  // No response at all: the request never got through.
  return "offline";
}
