import "server-only";

import { cache } from "react";
import type { PhfHand } from "../phf/types";
import { getServerSupabase } from "../supabase/server";

/**
 * Reading published hands, server-side, for `/p/[publicId]`, profiles and the
 * sitemap.
 *
 * Everything here reads through `read_published_hand` /
 * `published_hands_by_author` / the `published_hands` table as `anon` would:
 * the visibility policy decides what exists, and the document is the scrubbed
 * copy `publish_hand` stored. There is nothing to redact on the way out,
 * because nothing identifying was ever stored.
 */

const PUBLIC_ID = /^[23456789abcdefghjkmnpqrstuvwxyz]{10}$/;

export interface PublishedHand {
  publicId: string;
  title: string | null;
  mode: "pseudonyms" | "positions" | "as-imported";
  phf: PhfHand;
  site: string;
  stakesLabel: string | null;
  gameFormat: string;
  heroPosition: string | null;
  playedOn: string | null;
  createdAt: string;
  author: { username: string } | null;
}

export type PublishedReadResult =
  | { status: "ok"; hand: PublishedHand }
  | { status: "deleted" | "removed" | "not-found" | "unconfigured" | "error" };

export const readPublishedHand = cache(async (publicId: string): Promise<PublishedReadResult> => {
  if (!PUBLIC_ID.test(publicId)) {
    return { status: "not-found" };
  }
  const supabase = await getServerSupabase();
  if (!supabase) {
    return { status: "unconfigured" };
  }
  const { data, error } = await supabase.rpc("read_published_hand", { p_public_id: publicId });
  if (error) {
    return { status: "error" };
  }
  const row = data as (Partial<PublishedHand> & { status?: string }) | null;
  if (!row) {
    return { status: "not-found" };
  }
  if (row.status === "deleted" || row.status === "removed") {
    return { status: row.status };
  }
  if (!row.phf) {
    return { status: "error" };
  }
  return { status: "ok", hand: row as PublishedHand };
});

export interface PublishedHandSummary {
  publicId: string;
  title: string | null;
  site: string;
  stakesLabel: string | null;
  heroPosition: string | null;
  heroCards: string[];
  boardCards: string[];
  playedOn: string | null;
  createdAt: string;
}

export const publishedHandsByAuthor = cache(
  async (username: string, limit = 20): Promise<PublishedHandSummary[]> => {
    const supabase = await getServerSupabase();
    if (!supabase) {
      return [];
    }
    const { data, error } = await supabase.rpc("published_hands_by_author", {
      p_username: username,
      p_limit: limit,
    });
    if (error || !Array.isArray(data)) {
      return [];
    }
    return data as unknown as PublishedHandSummary[];
  },
);

/** For the sitemap: the most recent publications, newest first. */
export async function recentPublishedHands(limit = 5000): Promise<Array<{ publicId: string; createdAt: string }>> {
  const supabase = await getServerSupabase();
  if (!supabase) {
    return [];
  }
  const { data, error } = await supabase
    .from("published_hands")
    .select("public_id, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error || !data) {
    return [];
  }
  return data.map((row) => ({ publicId: String(row.public_id), createdAt: String(row.created_at) }));
}
