import "server-only";

import { cache } from "react";
import type { Board, FeedPage, FeedSort, ForumComment, ForumPost, PollState, SearchHit } from "../forum/types";
import { getAnonServerSupabase } from "../supabase/server";

/**
 * The forum's server reads. **All of them as `anon`** — see
 * `getAnonServerSupabase` for why the HTML must be the same for everybody.
 */

const POST_ID = /^[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;

export const readBoards = cache(async (): Promise<Board[]> => {
  const supabase = getAnonServerSupabase();
  if (!supabase) return [];
  const { data } = await supabase
    .from("boards")
    .select("slug, name, description")
    .order("sort_order")
    .order("name");
  return (data ?? []) as Board[];
});

export const readFeed = cache(
  async (board: string | null, sort: FeedSort, after: string | null): Promise<FeedPage | null> => {
    const supabase = getAnonServerSupabase();
    if (!supabase) return null;
    const { data, error } = await supabase.rpc("forum_feed", {
      p_board: board ?? undefined,
      p_sort: sort,
      p_after: after ?? undefined,
      p_limit: 25,
    });
    if (error || !data) return null;
    return data as unknown as FeedPage;
  },
);

export type PostReadResult =
  | { status: "ok"; post: ForumPost }
  | { status: "deleted" | "removed" | "not-found" | "unconfigured" | "error" };

export const readPost = cache(async (publicId: string): Promise<PostReadResult> => {
  if (!POST_ID.test(publicId)) return { status: "not-found" };
  const supabase = getAnonServerSupabase();
  if (!supabase) return { status: "unconfigured" };
  const { data, error } = await supabase.rpc("get_post", { p_public_id: publicId });
  if (error) return { status: "error" };
  if (data) return { status: "ok", post: data as unknown as ForumPost };
  const status = await supabase.rpc("post_status", { p_public_id: publicId });
  if (status.data === "deleted" || status.data === "removed") return { status: status.data };
  return { status: "not-found" };
});

export const readComments = cache(async (publicId: string, sort: string): Promise<ForumComment[]> => {
  const supabase = getAnonServerSupabase();
  if (!supabase) return [];
  const { data } = await supabase.rpc("get_post_comments", { p_public_id: publicId, p_sort: sort });
  return (Array.isArray(data) ? data : []) as unknown as ForumComment[];
});

export const searchForum = cache(async (query: string): Promise<SearchHit[]> => {
  const supabase = getAnonServerSupabase();
  if (!supabase || !query.trim()) return [];
  const { data } = await supabase.rpc("search_forum", { p_query: query, p_limit: 30 });
  return (Array.isArray(data) ? data : []) as unknown as SearchHit[];
});

/** For the sitemap. */
export async function recentPosts(limit = 5000): Promise<Array<{ path: [string, string, string]; createdAt: string }>> {
  const supabase = getAnonServerSupabase();
  if (!supabase) return [];
  const { data } = await supabase
    .from("posts")
    .select("public_id, slug, created_at, edited_at, boards!inner(slug)")
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data ?? []).map((row: Record<string, unknown>) => ({
    path: [
      String((row.boards as { slug: string }).slug),
      String(row.public_id),
      String(row.slug),
    ],
    createdAt: String(row.edited_at ?? row.created_at),
  }));
}

/** A poll as an anonymous reader sees it: the spot, never the answer. */
export const readPollAnon = cache(async (publicId: string): Promise<PollState | null> => {
  if (!POST_ID.test(publicId)) return null;
  const supabase = getAnonServerSupabase();
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("read_poll", { p_post: publicId });
  if (error || !data) return null;
  return data as unknown as PollState;
});
