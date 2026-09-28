/**
 * Share links.
 *
 * A share slug is a capability URL: knowing it is the authorization. The
 * `shares` table has no grants and no RLS policies for the anon role at all, so
 * these two functions are the only way in — you cannot list shares, only
 * resolve one you already have. Both are a single round trip.
 *
 * The two halves have deliberately opposite auth rules, and that asymmetry is
 * the feature:
 *
 *  * **Creating** a share stores a hand, so it needs an account like any other
 *    write. `create_share` also refuses a `handId` the caller does not own —
 *    it is `security definer` and therefore sees past the owner policy on
 *    `hands`, so without that check a signed-in caller could mint a public link
 *    to a stranger's hand by guessing a uuid.
 *  * **Resolving** one needs nothing at all. Anyone holding the link can replay
 *    the hand, signed in or not, which is the whole point of a share.
 *
 * Resolving is two RPCs, not one, since
 * `20261003090000_share_projection.sql`. `read_share` is `stable` and returns a
 * hand-shaped projection — never the `hands` row, which carried `source_text`,
 * `owner_id`, `hand_key` and `source_filename` to every stranger holding a
 * slug. `record_share_view` is the counter and nothing else, so a read-only
 * consumer (the Open Graph crawler function in `frontend/api/`) can exist
 * without every Slack unfurl registering as a human view.
 */

import type { PhfHand } from "../phf/types";
import { requireUserId, rpc } from "./client";
import type { CreateShareInput, ResolvedShare, ShareRef } from "./types";

const SLUG_PATTERN = /^[23456789abcdefghjkmnpqrstuvwxyz]{8,16}$/;

/**
 * Creates a share link.
 *
 * Pass `handId` when the hand is already stored — the share then follows the
 * stored row instead of pinning a stale copy. Pass `phf` (and ideally
 * `standardText`) for a hand that was never saved, e.g. one the user pasted
 * into the replayer with saving turned off.
 *
 * The slug is generated server-side with a CSPRNG. A client-generated slug
 * would let a caller pick one, and picking one is how you overwrite or
 * enumerate somebody else's share.
 */
export async function createShare(input: CreateShareInput): Promise<ShareRef> {
  const handId = input.handId ?? input.storedHandId ?? null;
  const standardText = input.standardText ?? input.handText ?? null;

  if (!handId && !input.phf) {
    throw new Error("createShare needs either a stored hand id or a PHF payload.");
  }

  await requireUserId(
    "Sign in to create a share link. Anyone you send the link to can open it without an account.",
  );

  const payload = await rpc<{ id: string; slug: string }>("create_share", {
    p_hand_id: handId,
    // Embedding is pointless when the share references a stored hand, and the
    // server ignores it in that case; sending null keeps the row small.
    p_phf: handId ? null : (input.phf ?? null),
    p_standard_text: handId ? null : standardText,
    p_title: input.title ?? null,
    // Absent is the same as false server-side; sent explicitly so the wire call
    // states the choice rather than relying on the column default.
    p_spoilers: input.spoilers === true,
  });

  return { id: payload.id, slug: payload.slug, reused: false };
}

/**
 * Counts one view of a share.
 *
 * Deliberately not exported from `lib/db`: it is a side effect of resolving,
 * and a caller that can fire it on its own will eventually fire it twice for
 * one page. `resolveShare()` below is the only caller.
 *
 * Never throws. The counter is decoration on a page whose job is to show a
 * hand — the server already swallows its own rate-limit refusals for the same
 * reason — so a failure here must not turn a readable share into an error
 * state. The server's `p_slug` shape check makes an unknown slug a no-op.
 */
async function recordShareView(slug: string): Promise<void> {
  try {
    await rpc<boolean>("record_share_view", { p_slug: slug });
  } catch {
    // Intentionally silent; see above.
  }
}

/**
 * Resolves a share slug and counts the view.
 *
 * Returns null for an unknown or malformed slug — the two are deliberately
 * indistinguishable, so probing tells an attacker nothing.
 *
 * Two calls, and the order matters: the view is only recorded once the read has
 * succeeded, so a slug that does not resolve never appears in the counters. The
 * second call is fire-and-forget — the caller gets its hand as soon as
 * `read_share` answers and never waits on a counter.
 *
 * The eventual goal is once per session (a `sessionStorage` guard keyed by
 * slug), so a reload of a share page does not inflate the number. Until then
 * this matches the old behaviour, which counted every resolve.
 */
export async function resolveShare(slug: string): Promise<ResolvedShare | null> {
  if (!slug || !SLUG_PATTERN.test(slug)) {
    return null;
  }

  const payload = await rpc<Record<string, unknown> | null>("read_share", { p_slug: slug });
  if (!payload) {
    return null;
  }

  void recordShareView(slug);

  const standardText = (payload.standardText as string | null) ?? "";

  return {
    slug: String(payload.slug),
    title: (payload.title as string | null) ?? null,
    // Defaults closed. A payload from a database that predates the column, or a
    // deployment where the migration has not landed, must not start leaking the
    // result into unfurls because a key was missing.
    spoilers: payload.spoilers === true,
    views: Number(payload.views ?? 0),
    createdAt: (payload.createdAt as string | null) ?? null,
    storedHandId: (payload.handId as string | null) ?? null,
    // Already redacted server-side: `meta.rawText`, `meta.originalFilename`,
    // `meta.warnings` and `meta.parsedAt` are gone. Nothing here should try to
    // read them, and nothing should try to put them back.
    phf: (payload.phf as PhfHand | null) ?? null,
    standardText,
    // The share UI's `ResolvedShare` shape calls this `handText`.
    handText: standardText,
    preview: null,
  };
}
