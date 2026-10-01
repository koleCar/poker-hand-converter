/**
 * The per-parser variant allowlist, and the canonical label that goes with it.
 *
 * ## Why an allowlist and not a flag
 *
 * Every parser used to carry the same line - `if (variant !== "holdem") throw` -
 * and the obvious way to ship Omaha is to flip that line everywhere at once.
 * That would be wrong. A parser is a reader of one room's grammar, and knowing
 * how to read *that room's Hold'em* says nothing about whether it reads that
 * room's Omaha: the deal block is a different length, the summary describes a
 * different hand, and some rooms change the header wording as well. The
 * evidence that a parser understands a variant is its own fixtures parsing
 * cleanly, and that evidence arrives one room at a time.
 *
 * So the lock is a list per parser, and a variant goes on a list only once the
 * corpus tests for that site pass with `meta.warnings === []`. A parser with no
 * Omaha fixtures keeps a Hold'em-only list; a parser whose four-card hands are
 * clean but whose five-card hands are not gets `["holdem", "omaha"]` and keeps
 * refusing `omaha5`. Partial unlocking is the normal outcome, not a failure.
 *
 * ## Short deck is not on any list
 *
 * Six-plus Hold'em is dealt from a 36-card deck, a flush beats a full house and
 * `A-6-7-8-9` is a straight. Nothing downstream - hand class, made-hand
 * strength, equity - models any of that, and a short-deck hand read as Hold'em
 * balances against itself exactly the way a hi/lo hand read as Omaha does. It
 * is refused on its own terms here and will be unlocked, if ever, by its own
 * issue.
 *
 * `variantFromLabel` cannot be relied on to spot it: ACR spells it
 * **`Six Plus Hold'em`**, which contains the word Hold'em and no `6+`, so the
 * shared reader answers `holdem`. That is safe while the reader is only asked
 * about labels that already passed a room's own lock, but it is not safe as the
 * *basis* of a lock, which is why `isShortDeckLabel` below tests the spellings
 * directly and runs before the allowlist check.
 */

import { ParseSkip } from "../../phf/detect";
import { variantFromLabel, type LimitType, type Variant } from "../../phf/types";

/** Hold'em only: the list a parser has until its own fixtures say otherwise. */
export const HOLDEM_ONLY: readonly Variant[] = ["holdem"];

/** Hold'em plus four-card Omaha. */
export const HOLDEM_OMAHA: readonly Variant[] = ["holdem", "omaha"];

/** Hold'em plus the whole big-O family the rooms actually spread. */
export const HOLDEM_OMAHA_FAMILY: readonly Variant[] = ["holdem", "omaha", "omaha5", "omaha6"];

/**
 * Every spelling of short deck in the sample corpus, plus the obvious near
 * misses.
 *
 * Spellings the corpus contains: ACR `Six Plus Hold'em`, GGPoker
 * `NLHold'em Short Deck` / `Short Deck`, and the `6+` form the fpdb reference
 * corpus files are named after. Deliberately generous for the same reason
 * `isHiLoLabel` is: a false positive costs one refused hand that a user can
 * report, a false negative books a 36-card hand as a 52-card one.
 */
export function isShortDeckLabel(label: string): boolean {
  return (
    /short\s*deck/i.test(label) ||
    /\b6\s*\+/.test(label) ||
    /\bsix[\s-]*plus\b/i.test(label) ||
    /\bshortdeck\b/i.test(label)
  );
}

/**
 * A room's own game name, spelled the way the shared readers expect.
 *
 * Both readers - `variantFromLabel` and `isHiLoLabel` - are written against
 * prose labels with spaces in them, and two rooms in this corpus do not write
 * prose. Feeding them a raw token from those rooms gets a wrong answer, and one
 * of the two wrong answers is dangerous:
 *
 *  - **Ongame** writes `OMAHA_HI_LO`. `isHiLoLabel` looks for `\bhi[\s/._-]?lo`,
 *    and an underscore is a *word* character, so there is no word boundary
 *    before `HI` and the test fails. A split-pot hand would then be read as
 *    plain Omaha - which balances against itself, which is exactly the failure
 *    the hi/lo refusal exists to prevent. Underscores become spaces.
 *  - **888poker** writes `Pot Limit OmahaHL`. None of `isHiLoLabel`'s seven
 *    patterns match a bare `HL` welded to the game word - the closest,
 *    `\bh\s?\/\s?l\b`, wants the slash - so this is the same dangerous miss as
 *    Ongame's, in a different spelling. `<game>HL` becomes `<game> Hi/Lo`.
 *  - **Entraction** writes `5-Card Omaha High`, and the five-card test is
 *    `/5\s*card\s*omaha/`, which does not cross a hyphen - so a five-card hand
 *    comes back as four-card `omaha`. The validator catches that one
 *    (`hole-card-overflow`), so it costs a wrong refusal rather than a wrong
 *    hand, but it is still wrong.
 *
 * The hyphen repair is deliberately narrow: a hyphen between a digit and the
 * word "card", nothing else. Normalising hyphens generally would break GG's
 * `PLO-5` and `PLO-6`, where the hyphen is part of the token and a space in its
 * place reads as plain `PLO`.
 *
 * Both of these are limitations of the shared readers in `phf/types.ts` rather
 * than of any one parser; the normalisation lives here because that file is the
 * settled format and this one is the parsers' own.
 */
export function normalizeGameName(label: string): string {
  return label
    .replace(/_/g, " ")
    .replace(/(\d)\s*-\s*card\b/gi, "$1 card")
    .replace(/\b(omaha|stud)\s*-?\s*h\s*\/?\s*l\b/gi, "$1 Hi/Lo");
}

/** The variant a room's own game name describes. */
export function variantOf(label: string): Variant {
  return variantFromLabel(normalizeGameName(label));
}

/**
 * The refusal a hand earns for being a variant this parser has not been proven
 * against.
 *
 * Returns `null` when the label is a game the parser may read. Short deck is
 * tested first and never passes, whatever the list says.
 *
 * Call this *after* `unsupportedGameSkip`, so a hi/lo hand keeps its own, more
 * specific reason code rather than being swallowed by this one.
 */
export function unsupportedVariantSkip(
  label: string,
  allowed: readonly Variant[],
): ParseSkip | null {
  const named = label.trim() ? `"${label.trim()}"` : "This hand";
  if (isShortDeckLabel(normalizeGameName(label))) {
    return new ParseSkip(
      "unsupported-variant",
      `${named} is a short-deck game. It is dealt from 36 cards, a flush beats a ` +
        "full house and A-6-7-8-9 is a straight; none of that is modelled yet, and a " +
        "short-deck hand read as Hold'em balances against itself - so it is refused " +
        "rather than approximated.",
    );
  }
  const variant = variantOf(label);
  if (allowed.includes(variant)) {
    return null;
  }
  return new ParseSkip(
    "unsupported-variant",
    `${named} is ${describe(variant)}, which this parser has not been verified ` +
      `against. It reads ${allowed.map(describe).join(" and ")}.`,
  );
}

/** Human wording for a variant, for refusal messages. */
function describe(variant: Variant): string {
  switch (variant) {
    case "holdem":
      return "Hold'em";
    case "omaha":
      return "Omaha";
    case "omaha5":
      return "five-card Omaha";
    case "omaha6":
      return "six-card Omaha";
    case "shortdeck":
      return "short-deck Hold'em";
    case "stud":
      return "seven-card stud";
    case "razz":
      return "razz";
    case "draw":
      return "a draw game";
    default:
      return "a game this converter does not recognise";
  }
}

/**
 * The GG-style game label for a variant and limit.
 *
 * The rooms that normalize through standard text - everything built on
 * `p2-handbuilder`, `p5-handdraft` and `p6-handbuilder` - do not carry a
 * `PhfGame` of their own. They write a label into the draft and the standard
 * text reader turns it back into `variant` / `limit` / `hiLo`. So the label is
 * the wire format between the two halves, and it has to be a string those
 * readers agree on: every value this returns is round-tripped by
 * `variantFromLabel` and `limitFromLabel`, which `tests/test/phfOmahaParsers.test.ts`
 * asserts over every combination.
 *
 * The wording is PokerStars', because that is what the standard text already
 * emits for Hold'em and what Holdem Manager and PokerTracker import.
 */
export function canonicalGameLabel(variant: Variant, limit: LimitType): string {
  const game =
    variant === "omaha"
      ? "Omaha"
      : variant === "omaha5"
        ? "5 Card Omaha"
        : variant === "omaha6"
          ? "6 Card Omaha"
          : "Hold'em";
  const suffix = limit === "pl" ? "Pot Limit" : limit === "fl" ? "Limit" : "No Limit";
  return `${game} ${suffix}`;
}
