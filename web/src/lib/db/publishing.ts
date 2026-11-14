/**
 * Publishing a hand — the client half of
 * `supabase/migrations/20261012090000_forum_publishing.sql`.
 *
 * `publish_hand` takes the id of a hand already in the caller's library, reads
 * that row itself, and scrubs it in SQL. The document goes along only for a
 * hand stored as its standard text (20271114090000), whose PHF the server no
 * longer has: the server publishes it only when it is that stored hand
 * (`hand_phf_matches`), through the same scrubber - so a client still cannot
 * publish a document of its choosing.
 */

import type { PhfHand } from "../phf/types";
import { rpc } from "./client";
import { getHand } from "./hands";

export type PublishMode = "pseudonyms" | "positions" | "as-imported";

export interface PublishResult {
  publicId: string;
  /** The hand had been published before; this is that publication. */
  alreadyPublished: boolean;
}

export async function publishHand(
  handId: string,
  mode: PublishMode = "pseudonyms",
  title?: string | null,
  /** The stored hand as the caller has it; read with `getHand` when omitted. */
  phf?: PhfHand | null,
): Promise<PublishResult> {
  const document = phf ?? (await getHand(handId))?.phf ?? null;
  return rpc<PublishResult>("publish_hand", {
    p_hand_id: handId,
    p_mode: mode,
    p_title: title?.trim() || null,
    p_phf: document,
  });
}

export async function unpublishHand(publicId: string): Promise<boolean> {
  return rpc<boolean>("unpublish_hand", { p_public_id: publicId });
}

/** `{ [storedHandId]: publicId }` for the given ids that are published. */
export async function myPublishedHandIds(handIds: string[]): Promise<Record<string, string>> {
  if (handIds.length === 0) {
    return {};
  }
  return rpc<Record<string, string>>("my_published_hand_ids", { p_hand_ids: handIds.slice(0, 500) });
}

/** The sentence part of a `publish_hand` refusal. */
export function publishErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^(publish_hand|unpublish_hand):\s*/, "");
}
