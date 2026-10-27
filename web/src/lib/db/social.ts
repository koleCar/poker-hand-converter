/**
 * Saves, thread subscriptions and notifications, from the browser.
 * `20261026090000_forum_social.sql` has the rules; nothing here decides any.
 */

import type { ForumPost } from "../forum/types";
import { rpc } from "./client";

export type SubscriptionLevel = "watching" | "muted" | null;

export interface PostState {
  saved: boolean;
  subscription: SubscriptionLevel;
}

export interface NotificationItem {
  id: number;
  kind: "comment_reply" | "post_reply" | "mention" | "thread";
  createdAt: string;
  read: boolean;
  actor: { username: string } | null;
  post: { publicId: string; slug: string; title: string; board: string };
  seq: number | null;
  excerpt: string | null;
}

export function savePost(publicId: string, saved: boolean) {
  return rpc<boolean>("save_post", { p_public_id: publicId, p_saved: saved });
}

export function setThreadSubscription(publicId: string, level: SubscriptionLevel) {
  return rpc<SubscriptionLevel>("set_thread_subscription", { p_public_id: publicId, p_level: level });
}

export function myPostState(publicId: string) {
  return rpc<PostState | null>("my_post_state", { p_public_id: publicId });
}

export function mySavedPosts() {
  return rpc<Array<ForumPost & { savedAt: string }>>("my_saved_posts", { p_limit: 50 });
}

export function myNotifications() {
  return rpc<{ unread: number; items: NotificationItem[] }>("my_notifications", { p_limit: 50 });
}

export function unreadNotificationCount() {
  return rpc<number>("unread_notification_count");
}

export function markNotificationsRead(ids?: number[]) {
  return rpc<number>("mark_notifications_read", { p_ids: ids ?? null });
}
