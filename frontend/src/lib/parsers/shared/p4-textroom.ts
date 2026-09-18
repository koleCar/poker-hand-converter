/**
 * Helpers shared by the plain-text rooms in this batch (Unibet, Ongame).
 *
 * Both write action lines as `<player name> <verb> ...` with nothing separating
 * the two, and both allow names that no regex can safely guess the end of:
 * `BONUS 1OOO`, `---Cockatrice---`, `Tiresias.`, and - before its session token
 * is stripped - `hero[Unibet_28204e08...]`. A lazy `^(.+?)\s+folds$` picks the
 * wrong name the first time somebody is called `Jim folds often`; a greedy one
 * picks the wrong name the first time two names overlap. The seat list is the
 * only reliable authority, and both rooms print it before the first action.
 */

import { ParseSkip } from "../../phf/detect";

/**
 * Splits `<player name><rest of line>` using the known seat names.
 *
 * `namesByLength` must be sorted longest first, because one player's name can be
 * a prefix of another's (`Bob` and `Bobby`). The character after the match has
 * to be a space or the end of the line, so `Bobby folds` is never read as `Bob`
 * plus `by folds`.
 */
export function leadingName(
  line: string,
  namesByLength: string[],
): { name: string; rest: string } | null {
  for (const name of namesByLength) {
    if (!line.startsWith(name)) {
      continue;
    }
    const next = line.charAt(name.length);
    if (next === "" || next === " ") {
      return { name, rest: line.slice(name.length).trim() };
    }
  }
  return null;
}

/** Seat names sorted longest first, ready for `leadingName`. */
export function namesByLength(names: string[]): string[] {
  return [...names].sort((a, b) => b.length - a.length);
}

/**
 * The currency glyph in front of an amount, or `""` when there is none.
 *
 * Multi-character symbols (`kr`, `zł`, `R$`) come back whole, which is what
 * `unitForSymbol` expects.
 */
export function currencySymbolOf(token: string): string {
  return token.match(/^([^\s\d.,+-]+)/)?.[1] ?? "";
}

/**
 * Base64 of a UTF-16LE string, which is how MicroGaming smuggles text that its
 * own attributes cannot hold safely.
 *
 * `unicodealias="RAB1AGMAawBHAGgAbwB1AGwA"` is `DuckGhoul` and
 * `currencysymbol="rCA="` is `€`. Because it is a byte-exact encoding of the
 * original UTF-16, it survives whatever the file's own byte encoding did to the
 * plain-text copy of the same value - which is why it is preferred over it.
 *
 * Returns `""` for anything that does not decode, so the caller can fall back
 * rather than store a mangled name.
 */
export function decodeBase64Utf16(value: string): string {
  if (!value) {
    return "";
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    return "";
  }
  if (binary.length % 2 !== 0) {
    return "";
  }
  let out = "";
  for (let i = 0; i < binary.length; i += 2) {
    out += String.fromCharCode(binary.charCodeAt(i) | (binary.charCodeAt(i + 1) << 8));
  }
  return out;
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * `Jan` -> `January`.
 *
 * Ongame stamps `Mon Jan 06 01:06:00 CET 2014`, i.e. an abbreviated month, while
 * `isoFromPartyDate` in `p2-partygaming.ts` wants the full name partypoker
 * writes. Expanding here means the timezone table stays in one place rather than
 * being copied for the sake of three letters. An unknown abbreviation comes back
 * unchanged, so the caller's date parse fails visibly instead of silently
 * landing in January.
 */
export function expandMonth(abbreviation: string): string {
  const prefix = abbreviation.slice(0, 3).toLowerCase();
  return MONTH_NAMES.find((name) => name.toLowerCase().startsWith(prefix)) ?? abbreviation;
}

/**
 * Refuses text whose bytes did not survive decoding.
 *
 * The Nordic-market rooms in this batch really do ship single-byte exports, and
 * the app's upload path decodes everything as UTF-8. A high byte that is not
 * valid UTF-8 becomes U+FFFD and is then unrecoverable: Windows-1252 `0x80`
 * (`€`) and `0xA3` (`£`) collapse onto the same replacement character.
 *
 * The danger is that this is *silent*. `parseAmount` ignores the symbol, so
 * every number still parses and the hand balances perfectly - it is simply
 * denominated in the wrong currency, or played by somebody whose name is not
 * quite their name. Refusing is the only honest answer, and the message has to
 * tell the user what to do about it.
 */
export function refuseLossyText(text: string, room: string): void {
  if (!text.includes("�")) {
    return;
  }
  throw new ParseSkip(
    "lossy-encoding",
    `This ${room} file was written in a single-byte encoding (Windows-1252) but ` +
      "decoded as UTF-8, so currency symbols and accented characters in player " +
      "names have been replaced by U+FFFD and cannot be recovered. Re-save the " +
      "file as UTF-8 and upload it again.",
  );
}
