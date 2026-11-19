/**
 * The admin screens' reads (`20271119100000_admin.sql`). Every function
 * refuses a caller who is not an admin (42501); the screens show "Admins
 * only" then. The screenshots of a report are in the private `feedback`
 * bucket and are read through short-lived signed URLs, which the storage
 * policy grants to admins only.
 */

import { requireDb, rpc } from "./client";

export type UserSort = "created" | "signed_in" | "hands" | "last_hand" | "posts" | "feedback" | "email" | "username";

export interface AdminUserRow {
  id: string;
  email: string | null;
  username: string | null;
  role: string | null;
  plan: string | null;
  plan_status: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  email_confirmed: boolean;
  banned: boolean;
  hands: number;
  last_hand_at: string | null;
  posts: number;
  feedback: number;
  total: number;
}

export function adminUsers(args: {
  search: string;
  sort: UserSort;
  desc: boolean;
  limit: number;
  offset: number;
}): Promise<AdminUserRow[]> {
  return rpc<AdminUserRow[]>("admin_users", {
    p_search: args.search.trim() || null,
    p_sort: args.sort,
    p_desc: args.desc,
    p_limit: args.limit,
    p_offset: args.offset,
  });
}

export type FeedbackStatus = "new" | "read" | "done" | "spam";
export type FeedbackKind = "bug" | "feature" | "question";

export interface AdminUserDetail {
  id: string;
  email: string | null;
  createdAt: string;
  lastSignInAt: string | null;
  emailConfirmedAt: string | null;
  providers: string[];
  profile: {
    username: string;
    role: string;
    karma: number;
    plan: string;
    planStatus: string | null;
    planPeriod: string | null;
    currentPeriodEnd: string | null;
    billingCustomer: boolean;
    bannedUntil: string | null;
    banReason: string | null;
    shadowbanned: boolean;
    digest: string;
  } | null;
  hands: {
    total: number;
    firstPlayedAt: string | null;
    lastPlayedAt: string | null;
    bySite: { site: string; hands: number }[];
    byOrigin: Record<string, number>;
  };
  sources: {
    kind: string;
    label: string | null;
    device: string | null;
    site: string | null;
    received: number;
    inserted: number;
    rejected: number;
    lastIngestAt: string | null;
    createdAt: string;
  }[];
  arrivals: { at: string; hands: number; origin: string }[];
  content: { posts: number; comments: number; publishedHands: number; shares: number; trainerAnswers: number };
  feedback: {
    id: string;
    createdAt: string;
    kind: FeedbackKind;
    status: FeedbackStatus;
    source: string;
    message: string;
    images: number;
  }[];
}

export function adminUser(id: string): Promise<AdminUserDetail | null> {
  return rpc<AdminUserDetail | null>("admin_user", { p_id: id });
}

export interface AdminFeedbackRow {
  id: string;
  created_at: string;
  kind: FeedbackKind;
  status: FeedbackStatus;
  message: string;
  email: string | null;
  user_id: string | null;
  username: string | null;
  user_email: string | null;
  source: "web" | "app";
  page: string | null;
  app_version: string | null;
  platform: string | null;
  locale: string | null;
  images: string[];
  total: number;
}

export function adminFeedback(args: {
  status: FeedbackStatus | null;
  kind: FeedbackKind | null;
  user: string | null;
  limit: number;
  offset: number;
}): Promise<AdminFeedbackRow[]> {
  return rpc<AdminFeedbackRow[]>("admin_feedback", {
    p_status: args.status,
    p_kind: args.kind,
    p_user: args.user,
    p_limit: args.limit,
    p_offset: args.offset,
  });
}

export type FeedbackCounts = Record<"all" | FeedbackStatus, number>;

export function adminFeedbackCounts(): Promise<FeedbackCounts> {
  return rpc<FeedbackCounts>("admin_feedback_counts");
}

export function adminSetFeedbackStatus(id: string, status: FeedbackStatus): Promise<void> {
  return rpc<void>("admin_feedback_set_status", { p_id: id, p_status: status });
}

/** Signed URLs for a report's screenshots, valid ten minutes; in the order given. */
export async function feedbackImageUrls(names: string[]): Promise<string[]> {
  if (names.length === 0) return [];
  const { data, error } = await requireDb().storage.from("feedback").createSignedUrls(names, 600);
  if (error || !data) throw new Error(error?.message ?? "no signed URLs");
  return data.map((entry) => entry.signedUrl ?? "");
}

/** A refusal from the admin functions: the caller is not an admin. */
export function isAdminRefusal(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return code === "42501" || message.includes("admin only");
}
