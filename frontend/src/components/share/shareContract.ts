/**
 * The shapes the share UI works in.
 *
 * `shareClient.ts` binds these to `frontend/src/lib/db/` (`createShare` /
 * `resolveShare`), which is owned by the database layer. Nothing in this file
 * talks to Supabase; it exists so the share components depend on one small,
 * stable vocabulary rather than on the database row layout.
 */

export interface SharePreview {
  handId: string | null;
  gameType: "cash" | "tournament";
  gameLabel: string;
  /** Pre-formatted stakes, e.g. "$0.5/$1". */
  stakes: string;
  currency: string;
  bigBlind: number;
  tableName: string | null;
  /** ISO timestamp, or null when the source had no date. */
  playedAt: string | null;
  playerCount: number;
  board: string[];
  winners: Array<{ player: string; amount: number }>;
  totalPot: number;
  heroName: string | null;
  heroCards: string[];
  streetReached: string;
  wentToShowdown: boolean;
  /**
   * Whether `title` and `description` are allowed to say how the hand ended.
   *
   * **False by default.** A link unfurl that reads "Villain wins $312" answers
   * the question the post exists to ask before anyone has opened it — see #23.
   * The winner-derived fields above (`winners`, `totalPot`) stay populated
   * because they are what the share *page* renders once the replay reaches the
   * award; this flag only governs the copy that travels outside the page.
   */
  spoilers: boolean;
  /** Ready-made copy for <title> / og:title. */
  title: string;
  /** Ready-made copy for og:description. */
  description: string;
}

export interface CreateShareRequest {
  /**
   * `hands.id` when the hand is already persisted. The share then follows the
   * stored row instead of pinning a copy of it.
   */
  storedHandId: string | null;
  /** Stable content hash of the hand, for logging and dedupe diagnostics. */
  handKey: string;
  /**
   * GG-style standard text. Embedded alongside the PHF document for unsaved
   * hands; ignored by the server when `storedHandId` is set.
   */
  handText: string;
  /**
   * Canonical `PhfHand`. Required for unsaved hands — the client derives it
   * from `handText` when the caller does not supply one.
   */
  phf?: unknown;
  /** Denormalised summary; supplies the human title stored with the share. */
  preview: SharePreview;
  /**
   * Stored on the share row and read back by the Open Graph renderer. Defaults
   * to `preview.spoilers`, which defaults to false; a sharer who explicitly
   * wants the result in the unfurl is the only way it gets set.
   */
  spoilers?: boolean;
}

export interface CreateShareResponse {
  /** Short, non-guessable, generated server-side by `create_share()`. */
  slug: string;
  /** Absolute URL to copy. */
  url: string;
  /** True when an existing share for the same hand was reused. */
  reused: boolean;
}

export interface ResolvedShare {
  slug: string;
  /** Human label stored with the share, when there is one. */
  title: string | null;
  /** Whether this link's own copy may reveal the result. False unless stored true. */
  spoilers: boolean;
  /** GG-style standard text, ready for `parseHand()`. */
  handText: string;
  /** The canonical `PhfHand` document, from the stored hand or the embedded copy. */
  phf?: unknown;
  /** Always null from the database layer; the page builds its own from the hand. */
  preview: SharePreview | null;
  createdAt: string | null;
  /** View counter after this resolve. */
  views: number;
  storedHandId: string | null;
}

export type ResolveShareResult =
  | { status: "ok"; share: ResolvedShare }
  /** No such slug — and a malformed slug is deliberately indistinguishable from it. */
  | { status: "not-found" }
  /** The share row exists but its hand is gone. */
  | { status: "gone" }
  /** No database configured in this build. */
  | { status: "unconfigured" }
  | { status: "error"; message: string };
