/**
 * The spot key: what a solved spot is cached under (plan §3.4).
 *
 * **What goes in** is everything that changes the answer and nothing that
 * identifies a person: the format, the table size, the stack bucket, the
 * preflop line, the two positions, the board in its suit-canonical spelling,
 * the street action so far in tree labels, the pot/stack bucket, the rake
 * profile and the tree profile (the bet menus), plus - when the caller passes
 * them - a hash of both ranges relabelled into the same canonical suits. No
 * hole cards and no names: two players who reach the same spot share one solve,
 * and the shared cache reveals nothing about either.
 *
 * **Readable, then hashed.** `spotKey` is a `|`-separated string a developer
 * can read in a database row; `spotHash` is a 64-bit FNV-1a of it for an index
 * column or a Storage path. Fields may not contain `|`, so no two different
 * part lists can produce the same string. `SOLVER_VERSION` is deliberately not
 * in the key - the cache is keyed by `(spot key, solver version)` - so a new
 * solver build can tell "this spot, solved by an older build" from "never seen".
 *
 * Ranges are quantised to 1/10000 before hashing, so float noise from the
 * narrowing upstream does not split one spot into many.
 */

import { canonicalBoard, canonicalSpot } from "./isomorphism";
import { NUM_COMBOS, SolverInputError } from "./combos";

export interface SpotKeyParts {
  /** e.g. `"nlhe-cash"`. */
  format: string;
  /** Seats at the table, e.g. 6. */
  players: number;
  /** e.g. `"100bb"`. */
  stackBucket: string;
  /** e.g. `"srp"`, `"3bp"`. */
  preflopLine: string;
  /** Positions as `[first to act, second]`, e.g. `["BB", "BTN"]`. */
  positions: readonly [string, string];
  /** The board, any suits; canonicalised here. */
  board: readonly (string | number)[];
  /** Postflop action so far in tree labels, streets separated by `/`, e.g. `"X-B33-C/X"`. */
  line: string;
  /** Pot/stack ratio bucket, e.g. `"spr3"`. */
  sprBucket: string;
  /** e.g. `"5%/3bb"` or `"none"`. */
  rake: string;
  /** Bet-menu profile id, e.g. `"m1"`. */
  tree: string;
  /** Both ranges as 1326 weights, hashed after canonical relabelling. */
  ranges?: readonly [ArrayLike<number>, ArrayLike<number>];
}

function field(name: string, value: string | number): string {
  const text = String(value);
  if (text.includes("|") || /\s/.test(text)) {
    throw new SolverInputError(`spot key field ${name} may not contain "|" or whitespace: ${text}`);
  }
  return text;
}

/** The readable spot key. */
export function spotKey(parts: SpotKeyParts): string {
  let board: string[];
  let rangeHash = "";
  if (parts.ranges) {
    if (parts.ranges[0].length !== NUM_COMBOS || parts.ranges[1].length !== NUM_COMBOS) {
      throw new SolverInputError(`ranges in a spot key are ${NUM_COMBOS} weights each`);
    }
    const canonical = canonicalSpot(parts.board, [parts.ranges[0], parts.ranges[1]]);
    board = canonical.board;
    const quantised: number[] = [];
    for (const range of canonical.ranges) {
      for (let c = 0; c < NUM_COMBOS; c += 1) {
        quantised.push(Math.round(range[c] * 10000));
      }
    }
    rangeHash = fnv1a64(quantised.join(","));
  } else {
    board = canonicalBoard(parts.board).board;
  }
  return [
    "spot1",
    field("format", parts.format),
    field("players", parts.players),
    field("stackBucket", parts.stackBucket),
    field("preflopLine", parts.preflopLine),
    `${field("positions", parts.positions[0])}>${field("positions", parts.positions[1])}`,
    board.join(""),
    field("line", parts.line || "-"),
    field("sprBucket", parts.sprBucket),
    field("rake", parts.rake),
    field("tree", parts.tree),
    rangeHash || "-",
  ].join("|");
}

/** 64-bit FNV-1a of a spot key, as 16 hex digits. */
export function spotHash(key: string): string {
  return fnv1a64(key);
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

function fnv1a64(text: string): string {
  let h = FNV_OFFSET;
  for (let k = 0; k < text.length; k += 1) {
    h ^= BigInt(text.charCodeAt(k) & 0xff);
    h = (h * FNV_PRIME) & MASK;
    const high = text.charCodeAt(k) >> 8;
    if (high) {
      h ^= BigInt(high);
      h = (h * FNV_PRIME) & MASK;
    }
  }
  return h.toString(16).padStart(16, "0");
}
