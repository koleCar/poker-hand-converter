/**
 * Reports and moderator / admin powers, from the browser. Every one of these is
 * a definer RPC that re-checks the caller's standing on the server — the UI
 * only decides which buttons to draw.
 */

import { rpc } from "./client";

export type ReportReason = "spam" | "harassment" | "cheating" | "off-topic" | "hh-takedown" | "other";
export type ReportSubject =
  | { type: "post"; publicId: string }
  | { type: "comment"; publicId: string; seq: number }
  | { type: "published_hand"; publicId: string }
  | { type: "profile"; username: string };

export function reportContent(subject: ReportSubject, reason: ReportReason, details?: string) {
  return rpc<{ reported: boolean; alreadyReported: boolean }>("report_content", {
    p_subject_type: subject.type,
    p_public_id: "publicId" in subject ? subject.publicId : null,
    p_seq: subject.type === "comment" ? subject.seq : null,
    p_username: subject.type === "profile" ? subject.username : null,
    p_reason: reason,
    p_details: details || null,
  });
}

export const canModeratePost = (publicId: string) => rpc<boolean>("can_moderate_post", { p_public_id: publicId });

export const setPostStatus = (publicId: string, status: "visible" | "removed", reason?: string) =>
  rpc<string>("mod_set_post_status", { p_public_id: publicId, p_status: status, p_reason: reason ?? null });

export const setCommentStatus = (publicId: string, seq: number, status: "visible" | "removed", reason?: string) =>
  rpc<string>("mod_set_comment_status", { p_post_public_id: publicId, p_seq: seq, p_status: status, p_reason: reason ?? null });

export const setPostFlags = (publicId: string, flags: { locked?: boolean; pinned?: boolean }, reason?: string) =>
  rpc<{ isLocked: boolean; isPinned: boolean }>("mod_set_post_flags", {
    p_public_id: publicId,
    p_locked: flags.locked ?? null,
    p_pinned: flags.pinned ?? null,
    p_reason: reason ?? null,
  });

export const editPostTitle = (publicId: string, title: string, reason?: string) =>
  rpc<{ slug: string }>("mod_edit_post_title", { p_public_id: publicId, p_title: title, p_reason: reason ?? null });

export const banUser = (username: string, days: number | null, reason: string) =>
  rpc<{ bannedUntil: string }>("mod_ban", { p_username: username, p_days: days, p_reason: reason });
export const unbanUser = (username: string, reason?: string) =>
  rpc<boolean>("mod_unban", { p_username: username, p_reason: reason ?? null });
export const shadowbanUser = (username: string, on: boolean, reason?: string) =>
  rpc<boolean>("mod_shadowban", { p_username: username, p_on: on, p_reason: reason ?? null });

export interface ModUser {
  username: string;
  role: "member" | "moderator" | "admin";
  karma: number;
  joinedOn: string;
  bannedUntil: string | null;
  banReason: string | null;
  isShadowbanned: boolean;
  posts: number;
  comments: number;
  reportsAgainst: number;
  history: Array<{ action: string; reason: string | null; createdAt: string }>;
}
export const modUser = (username: string) => rpc<ModUser | null>("mod_user", { p_username: username });
export const voteOverlap = (username: string) =>
  rpc<Array<{ with: string; sharedVotes: number; sameDirection: number }>>("mod_vote_overlap_for", { p_username: username });

export interface QueueItem {
  id: number;
  subjectType: "post" | "comment" | "published_hand" | "profile";
  reason: ReportReason;
  details: string | null;
  status: string;
  createdAt: string;
  reporter: string | null;
  subject: {
    publicId?: string;
    slug?: string;
    title?: string;
    board?: string;
    seq?: number;
    status?: string;
    excerpt?: string | null;
    author?: string | null;
    username?: string;
  } | null;
}
export const modQueue = () => rpc<QueueItem[]>("mod_queue", { p_status: "open" });

export interface SpamItem {
  type: "post" | "comment";
  publicId: string;
  slug: string;
  board: string;
  seq?: number;
  title: string;
  excerpt: string | null;
  createdAt: string;
  author: string | null;
}
export const spamQueue = () => rpc<SpamItem[]>("mod_spam_queue");
export const resolveReport = (id: number, status: "actioned" | "dismissed", note?: string) =>
  rpc<boolean>("mod_resolve_report", { p_id: id, p_status: status, p_note: note ?? null });
export const setPublishedHandStatus = (publicId: string, status: "visible" | "removed", reason?: string) =>
  rpc<string>("mod_set_published_hand_status", { p_public_id: publicId, p_status: status, p_reason: reason ?? null });

export const setRole = (username: string, role: "member" | "moderator" | "admin", reason?: string) =>
  rpc<string>("admin_set_role", { p_username: username, p_role: role, p_reason: reason ?? null });
export const createBoard = (slug: string, name: string, description?: string) =>
  rpc<string>("admin_create_board", { p_slug: slug, p_name: name, p_description: description ?? null });
export const setBoardModerator = (board: string, username: string, on: boolean) =>
  rpc<boolean>("admin_set_board_moderator", { p_board: board, p_username: username, p_on: on });

export const getRevisions = (publicId: string, seq?: number) =>
  rpc<Array<{ title: string | null; body: string | null; createdAt: string }>>("get_revisions", {
    p_post_public_id: publicId,
    p_seq: seq ?? null,
  });
