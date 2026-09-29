/**
 * The forum's writes and per-user reads, from the browser.
 *
 * Every write is a definer RPC — there is no UPDATE or DELETE grant on any
 * forum table (see the header of `20261019090000_forum_core.sql`). The actor
 * is `auth.uid()` on the server; nothing here says who is acting.
 */

import { rpc } from "./client";

export interface VoteCounts {
  upvotes: number;
  downvotes: number;
  score: number;
  myVote: -1 | 0 | 1;
}

export function createPost(input: { board: string; title: string; body: string; hand?: string | null }) {
  return rpc<{ publicId: string; board: string; slug: string }>("create_post", {
    p_board: input.board,
    p_title: input.title,
    p_body: input.body,
    p_published_hand: input.hand || null,
  });
}

export function editPost(publicId: string, title: string, body: string) {
  return rpc<{ publicId: string; slug: string }>("edit_post", { p_public_id: publicId, p_title: title, p_body: body });
}

export function deletePost(publicId: string) {
  return rpc<boolean>("delete_post", { p_public_id: publicId });
}

export function votePost(publicId: string, value: -1 | 0 | 1) {
  return rpc<VoteCounts>("vote_post", { p_public_id: publicId, p_value: value });
}

export function createComment(input: {
  post: string;
  body: string;
  parentSeq?: number | null;
  anchorActionIndex?: number | null;
  anchorStreet?: string | null;
  anchorSeat?: number | null;
}) {
  return rpc<{ seq: number }>("create_comment", {
    p_post_public_id: input.post,
    p_body: input.body,
    p_parent_seq: input.parentSeq ?? null,
    p_anchor_action: input.anchorActionIndex ?? null,
    p_anchor_street: input.anchorStreet ?? null,
    p_anchor_seat: input.anchorSeat ?? null,
  });
}

export function editComment(post: string, seq: number, body: string) {
  return rpc<boolean>("edit_comment", { p_post_public_id: post, p_seq: seq, p_body: body });
}

export function deleteComment(post: string, seq: number) {
  return rpc<boolean>("delete_comment", { p_post_public_id: post, p_seq: seq });
}

export function voteComment(post: string, seq: number, value: -1 | 0 | 1) {
  return rpc<VoteCounts>("vote_comment", { p_post_public_id: post, p_seq: seq, p_value: value });
}

export function myPostVotes(publicIds: string[]) {
  return rpc<Record<string, number>>("my_post_votes", { p_public_ids: publicIds.slice(0, 200) });
}

export function myCommentVotes(post: string) {
  return rpc<Record<string, number>>("my_comment_votes", { p_post_public_id: post });
}

/** The sentence part of a forum RPC refusal. */
export function forumErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^[a-z_]+:\s*/, "");
}
