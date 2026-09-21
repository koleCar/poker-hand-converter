/**
 * Classifying what a hand's player names are actually worth.
 *
 * Most sites print persistent screen names. Some do not, and the failure mode
 * is silent: a filter on `player_names = 'UTG+1'` over Ignition hands does not
 * error, it returns a different human from every row. This module decides, per
 * hand, which of three worlds a row lives in, so the schema and the UI can stop
 * pretending they are the same.
 *
 * | value | Meaning | Example | Names usable as identities? |
 * | --- | --- | --- | --- |
 * | `none` | Persistent screen names | PokerStars, WePlay | yes |
 * | `positional` | Position labels that remap every hand | Ignition / Bodog / Bovada | **no** — a name is a different person each hand |
 * | `opaque-id` | Per-session tokens: hashes or numeric ids | GGPoker, ACR/WPN data-mined | within a session only |
 *
 * `positional` is the destructive one, and it is the only one whose names get
 * dropped before they reach the database (see `handInsertFromPhf`). An
 * `opaque-id` token is unreadable and may not survive a session boundary, but
 * it never maps to a *different* human, and within one session it groups
 * correctly — so it is kept and labelled rather than thrown away.
 */

import type { PhfHand, PhfPlayer } from "../phf/types";
import type { SiteAnonymization } from "./types";

/**
 * Sites whose villain names are position labels.
 *
 * Ignition prints `Dealer` / `Small Blind` / `UTG+2` for every seat and tags
 * the hero `[ME]`. The button rotates, so the label is a per-hand coordinate,
 * not a person.
 */
const POSITIONAL_SITES = new Set(["ignition"]);

/** Sites that replace every villain with a per-session token. */
const OPAQUE_ID_SITES = new Set(["ggpoker"]);

/**
 * Parser warning codes that say "the names I emitted are not screen names".
 *
 * Per-hand rather than per-site on purpose: ACR/WPN's data-mined dialect shares
 * a `siteId` with its two normal dialects, so only the warning distinguishes
 * them. Note that Ignition's `mvs-player-hashes` is deliberately *not* here —
 * those hashes live in the warning text as provenance, while the names on that
 * hand are still positional pseudonyms.
 */
const OPAQUE_ID_WARNINGS = new Set(["numeric-player-ids"]);

/** Ignition's full pseudonym vocabulary. */
const POSITION_PSEUDONYM = /^(?:dealer|small blind|big blind|utg(?:\+\d+)?)$/i;

/** A hex hash or a long numeric id, with nothing human in it. */
const OPAQUE_TOKEN = /^(?:[0-9a-f]{6,}|\d{5,})$/i;

/**
 * Structural detection needs at least this many villains to fire.
 *
 * Heads-up, one villain called `Dealer` is as likely to be somebody's actual
 * screen name as it is to be a pseudonym. With three or more seats all matching,
 * coincidence stops being a plausible explanation.
 */
const MIN_VILLAINS_FOR_STRUCTURAL = 2;

function villainsOf(hand: PhfHand): PhfPlayer[] {
  return hand.players.filter((player) => !player.isHero);
}

/**
 * Decides how much the names on this hand can be trusted.
 *
 * Explicit signals (site registry, parser warnings) are authoritative and are
 * checked first. A structural fallback then catches sites nobody has classified
 * yet: if *every* villain name is a position label or an opaque token, the names
 * are not identities regardless of which site produced them. That is what makes
 * a future anonymizing room a data value rather than a code change — it gets
 * labelled correctly the first time someone uploads one.
 *
 * The structural rules are deliberately conservative: they require unanimity
 * across villains, so one player called `Dealer` at a table of normal names
 * changes nothing. And they are not destructive even when wrong — `phf` and
 * `source_text` keep the original names, so a misclassified hand can be
 * re-derived by a backfill.
 */
export function detectAnonymization(hand: PhfHand): SiteAnonymization {
  const siteId = hand.meta.siteId.trim().toLowerCase();

  if (POSITIONAL_SITES.has(siteId)) {
    return "positional";
  }
  if (OPAQUE_ID_SITES.has(siteId)) {
    return "opaque-id";
  }
  if (hand.meta.warnings.some((warning) => OPAQUE_ID_WARNINGS.has(warning.code))) {
    return "opaque-id";
  }

  const villains = villainsOf(hand);
  if (villains.length < MIN_VILLAINS_FOR_STRUCTURAL) {
    return "none";
  }
  const names = villains.map((player) => player.name.trim()).filter((name) => name.length > 0);
  if (names.length < MIN_VILLAINS_FOR_STRUCTURAL) {
    return "none";
  }

  if (names.every((name) => POSITION_PSEUDONYM.test(name))) {
    return "positional";
  }
  if (names.every((name) => OPAQUE_TOKEN.test(name))) {
    return "opaque-id";
  }
  return "none";
}

/**
 * True when villain names on this hand identify people across hands.
 *
 * The one predicate a filter UI needs: when it is false, the player-name filter
 * must be visibly disabled rather than quietly returning wrong rows. Use the
 * position filters instead — for these sites position *is* the identity.
 */
export function hasUsablePlayerNames(anonymization: SiteAnonymization): boolean {
  return anonymization === "none";
}

/** Human-readable explanation for the UI when names are not identities. */
export function anonymizationNote(anonymization: SiteAnonymization): string | null {
  switch (anonymization) {
    case "positional":
      return (
        "This room labels every seat by its position relative to the button, and the button " +
        "moves every hand, so villain names are not people. Filter by position instead."
      );
    case "opaque-id":
      return (
        "This room replaces villain names with per-session tokens. They group correctly " +
        "within one session, but the same token may be a different player in another."
      );
    default:
      return null;
  }
}
