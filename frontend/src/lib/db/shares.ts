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
 */

import type { PhfHand } from "../phf/types";
import { requireUserId, rpc } from "./client";
import { toHandRecord } from "./mapping";
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
  });

  return { id: payload.id, slug: payload.slug, reused: false };
}

/**
 * Resolves a share slug and counts the view.
 *
 * Returns null for an unknown or malformed slug — the two are deliberately
 * indistinguishable, so probing tells an attacker nothing. One request returns
 * the share, the PHF document and the standard text.
 */
export async function resolveShare(slug: string): Promise<ResolvedShare | null> {
  if (!slug || !SLUG_PATTERN.test(slug)) {
    return null;
  }

  const payload = await rpc<Record<string, unknown> | null>("resolve_share", { p_slug: slug });
  if (!payload) {
    return null;
  }

  const handRow = payload.hand as Record<string, unknown> | null;
  const hand = handRow ? toHandRecord(handRow) : null;
  const standardText = (payload.standardText as string | null) ?? "";

  return {
    slug: String(payload.slug),
    title: (payload.title as string | null) ?? null,
    views: Number(payload.views ?? 0),
    createdAt: (payload.createdAt as string | null) ?? null,
    storedHandId: (payload.handId as string | null) ?? null,
    phf: (payload.phf as PhfHand | null) ?? null,
    standardText,
    // The share UI's `ResolvedShare` shape calls this `handText`.
    handText: standardText,
    hand,
    preview: null,
  };
}
