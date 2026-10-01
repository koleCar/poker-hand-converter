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
  /** Set when the post is a "what would you do?" poll; the hand is then sealed. */
  poll?: PollSummary | null;
}

export type PollChoice = "fold" | "check" | "call" | "bet" | "raise" | "allin";

/** What a feed card may know about a poll: never the answer. */
export interface PollSummary {
  options: PollChoice[];
  hideHeroCards: boolean;
  votes: number;
}

/** `read_poll()`: the poll as the caller may see it. */
export interface PollState extends PollSummary {
  stopIndex: number;
  myVote: { choice: PollChoice; sizePct: number | null } | null;
  isAuthor: boolean;
  /** True once the caller has voted, or is the author or a moderator. */
  revealed: boolean;
  /** Per choice, only when revealed. */
  results: Partial<Record<PollChoice, { votes: number; medianSizePct: number | null }>> | null;
  /** The spot before the reveal, the whole hand after; null if the hand was unpublished. */
  phf: PhfHand | null;
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
