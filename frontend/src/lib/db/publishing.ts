/**
 * Publishing a hand — the client half of
 * `supabase/migrations/20261012090000_forum_publishing.sql`.
 *
 * Note what is *not* sent: the document. `publish_hand` takes the id of a hand
 * already in the caller's library, reads that row itself, and scrubs it in
 * SQL. A client that could send the document it wanted published could publish
 * anything — including the raw room text the scrubber exists to remove.
 */

import { rpc } from "./client";

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
): Promise<PublishResult> {
  return rpc<PublishResult>("publish_hand", {
    p_hand_id: handId,
    p_mode: mode,
    p_title: title?.trim() || null,
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
