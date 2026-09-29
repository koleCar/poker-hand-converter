/**
 * The forum's wire shapes, as `forum_post_json()` / `get_post_comments()` in
 * `supabase/migrations/20261019090000_forum_core.sql` build them.
 */

import type { PhfHand } from "../phf/types";

export type FeedSort = "hot" | "new" | "top";
export type CommentSort = "best" | "new" | "top";

export interface BoardRef {
  slug: string;
  name: string;
}

export interface Board extends BoardRef {
  description: string | null;
}

export interface PostHandPreview {
  publicId: string;
  site: string;
  stakesLabel: string | null;
  heroPosition: string | null;
  heroCards: string[];
  boardCards: string[];
  gameFormat: string;
  variant: string | null;
}

export interface ForumPost {
  publicId: string;
  board: BoardRef;
  kind: "hand" | "text";
  title: string;
  slug: string;
  body: string;
  author: { username: string } | null;
  upvotes: number;
  downvotes: number;
  score: number;
  commentCount: number;
  isLocked: boolean;
  isPinned: boolean;
  createdAt: string;
  editedAt: string | null;
  hand: PostHandPreview | null;
  /** Only on `get_post`: the published hand's scrubbed document. */
  handPhf?: PhfHand | null;
}

export interface CommentAnchor {
  actionIndex: number | null;
  street: string | null;
  seat: number | null;
}

export interface ForumComment {
  seq: number;
  parentSeq: number | null;
  depth: number;
  body: string | null;
  deleted: boolean;
  removed: boolean;
  author: { username: string } | null;
  upvotes: number;
  downvotes: number;
  score: number;
  createdAt: string;
  editedAt: string | null;
  anchor: CommentAnchor | null;
}

export interface FeedPage {
  posts: ForumPost[];
  next: string | null;
  sort: FeedSort;
}

export interface SearchHit {
  type: "post" | "comment";
  publicId: string;
  seq: number | null;
  title: string;
  slug: string;
  board: string;
  snippet: string;
  createdAt: string;
}
