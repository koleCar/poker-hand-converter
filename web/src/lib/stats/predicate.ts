/**
 * The predicate language of a custom statistic (docs/STATS-SPEC.md §14.2)
 * and its evaluation over decision events (`events.ts`): a counter defined
 * as `mode opportunity => action`.
 *
 * A port of `core/rail-config/src/stats/predicate.rs` (the grammar) and of
 * the evaluation in `core/rail-stats/src/custom.rs` (`FIELDS`, `count`,
 * `members`), so a predicate means the same on the web as in the app. The
 * Analytics catalogue (`analytics.ts`) is its first user on the web; the
 * golden corpus holds the two equal (`testdata/golden-analytics/`).
 *
 * ```text
 * counter    := mode condition ("=>" condition)?
 * mode       := "first" | "any" | "each"
 * condition  := conj ("or" conj)*
 * conj       := neg ("and" neg)*
 * neg        := "not" neg | "(" condition ")" | test
 * test       := field | field cmp value | field "in" "(" value ("," value)* ")"
 * ```
 *
 * Numbers are kept in thousandths (`2.5` is 2500), as the event sizes are.
 */

import type { DecisionEvent, HandEvents, SeatEvents } from "./events";

export const MAX_LENGTH = 1000;
export const MAX_DEPTH = 32;
export const MAX_IN_VALUES = 32;
const KEYWORDS = new Set(["first", "any", "each", "and", "or", "not", "in", "true", "false"]);

const STREETS = ["preflop", "flop", "turn", "river"] as const;
const ACTIONS = ["fold", "check", "call", "bet", "raise"] as const;
const FACING = ["none", "limp", "bet", "raise"] as const;
const POSITIONS = ["utg", "utg1", "utg2", "mp", "lj", "hj", "co", "btn", "sb", "bb"] as const;

type Kind = { type: "bool" } | { type: "number" } | { type: "choice"; words: readonly string[] };

/** A field's value for one event: null fails every test. */
type Val = boolean | number | string | null;

interface FieldDef {
  name: string;
  kind: Kind;
  /** Reads the seat's cards (R3.9). */
  cards?: boolean;
  value(hand: HandEvents, seat: SeatEvents, event: DecisionEvent): Val;
}

const BOOL: Kind = { type: "bool" };
const NUMBER: Kind = { type: "number" };
const choice = (words: readonly string[]): Kind => ({ type: "choice", words });
const num = (n: number): number => n * 1000;

/** Every field, in `custom.rs`'s `FIELDS` order. */
export const FIELDS: readonly FieldDef[] = [
  // The hand.
  { name: "bomb_pot", kind: BOOL, value: (h) => h.bombPot },
  { name: "straddle", kind: BOOL, value: (h) => h.straddle },
  { name: "button_blind", kind: BOOL, value: (h) => h.buttonBlind },
  { name: "walk", kind: BOOL, value: (h) => h.walk },
  { name: "dealt", kind: NUMBER, value: (h) => num(h.dealt) },
  { name: "max_seats", kind: NUMBER, value: (h) => num(h.maxSeats) },
  { name: "preflop_raises", kind: NUMBER, value: (h) => num(h.preflopRaises) },
  // The seat.
  { name: "hero", kind: BOOL, value: (_, s) => s.hero },
  {
    name: "position",
    kind: choice(POSITIONS),
    value: (_, s) => (s.position === null ? null : s.position.toLowerCase().replace("+", "")),
  },
  { name: "posted_blind", kind: BOOL, value: (_, s) => s.postedBlind },
  { name: "big_blind", kind: BOOL, value: (_, s) => s.bigBlind },
  { name: "preflop_aggressor", kind: BOOL, value: (_, s) => s.preflopAggressor },
  { name: "stack_bb", kind: NUMBER, value: (_, s) => s.stackBb },
  { name: "effective_bb", kind: NUMBER, value: (_, s) => s.effectiveBb },
  { name: "saw_flop", kind: BOOL, value: (_, s) => s.sawFlop },
  { name: "saw_turn", kind: BOOL, value: (_, s) => s.sawTurn },
  { name: "saw_river", kind: BOOL, value: (_, s) => s.sawRiver },
  { name: "showdown", kind: BOOL, value: (_, s) => s.showdown },
  { name: "won", kind: BOOL, value: (_, s) => s.won },
  { name: "cards_known", kind: BOOL, cards: true, value: (_, s) => s.cardsKnown },
  { name: "pocket_pair", kind: BOOL, cards: true, value: (_, s) => s.pocketPair },
  { name: "suited", kind: BOOL, cards: true, value: (_, s) => s.suited },
  // The decision.
  { name: "street", kind: choice(STREETS), value: (_, __, e) => (e.street === "showdown" ? null : e.street) },
  { name: "action", kind: choice(ACTIONS), value: (_, __, e) => e.action },
  { name: "all_in", kind: BOOL, value: (_, __, e) => e.allIn },
  { name: "facing", kind: choice(FACING), value: (_, __, e) => e.facing },
  { name: "raise_level", kind: NUMBER, value: (_, __, e) => num(e.raiseLevel) },
  { name: "limpers", kind: NUMBER, value: (_, __, e) => num(e.limpers) },
  { name: "callers", kind: NUMBER, value: (_, __, e) => num(e.callers) },
  { name: "first_on_street", kind: BOOL, value: (_, __, e) => e.firstOnStreet },
  { name: "first_at_level", kind: BOOL, value: (_, __, e) => e.firstAtLevel },
  { name: "checked_before", kind: BOOL, value: (_, __, e) => e.checkedBefore },
  { name: "own_raise", kind: NUMBER, value: (_, __, e) => num(e.ownRaise) },
  { name: "facing_steal", kind: BOOL, value: (_, __, e) => e.facingSteal },
  { name: "facing_cbet", kind: BOOL, value: (_, __, e) => e.facingCbet },
  { name: "barrels", kind: NUMBER, value: (_, __, e) => num(e.barrels) },
  { name: "initiative", kind: BOOL, value: (_, __, e) => e.initiative },
  { name: "ahead_of_aggressor", kind: BOOL, value: (_, __, e) => e.aheadOfAggressor },
  { name: "checked_through", kind: BOOL, value: (_, __, e) => e.checkedThrough },
  { name: "in_position", kind: BOOL, value: (_, __, e) => e.inPosition },
  { name: "players", kind: NUMBER, value: (_, __, e) => num(e.players) },
  { name: "multiway", kind: BOOL, value: (_, __, e) => e.players >= 3 },
  { name: "pot_bb", kind: NUMBER, value: (_, __, e) => e.potBb },
  { name: "size_bb", kind: NUMBER, value: (_, __, e) => e.sizeBb },
  { name: "size_pot", kind: NUMBER, value: (_, __, e) => e.sizePot },
  { name: "facing_size_pot", kind: NUMBER, value: (_, __, e) => e.facingSizePot },
];

export type Mode = "first" | "any" | "each";
export type Cmp = "=" | "!=" | "<" | "<=" | ">" | ">=";
/** A value resolved against its field: a bool, thousandths, or a choice word. */
export type Literal = boolean | number | string;

export type Cond =
  | { op: "test"; field: number; test: { kind: "true" } | { kind: "cmp"; cmp: Cmp; value: Literal } | { kind: "in"; values: Literal[] } }
  | { op: "not"; inner: Cond }
  | { op: "and"; parts: Cond[] }
  | { op: "or"; parts: Cond[] };

export interface Predicate {
  mode: Mode;
  opportunity: Cond;
  /** Null: every opportunity is made. */
  action: Cond | null;
}

export class PredicateError extends Error {
  readonly offset: number;
  readonly length: number;

  constructor(message: string, offset: number, length: number) {
    super(`${message} at offset ${offset}`);
    this.offset = offset;
    this.length = length;
  }
}

type Token =
  | { t: "word"; text: string }
  | { t: "number"; text: string }
  | { t: "cmp"; cmp: Cmp }
  | { t: "arrow" }
  | { t: "open" }
  | { t: "close" }
  | { t: "comma" }
  | { t: "end" };

interface Spanned {
  offset: number;
  length: number;
  token: Token;
}

function describe(token: Token): string {
  switch (token.t) {
    case "word":
      return `"${token.text}"`;
    case "number":
      return `number ${token.text}`;
    case "cmp":
      return `"${token.cmp}"`;
    case "arrow":
      return '"=>"';
    case "open":
      return '"("';
    case "close":
      return '")"';
    case "comma":
      return '","';
    case "end":
      return "the end";
  }
}

const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
const isLower = (c: string | undefined) => c !== undefined && c >= "a" && c <= "z";
const isAlpha = (c: string | undefined) => c !== undefined && /[A-Za-z]/.test(c);

/** Byte offsets in Rust; the language is ASCII, so code units serve until a non-ASCII character, which is an error. */
function tokenize(text: string): Spanned[] {
  const out: Spanned[] = [];
  let i = 0;
  while (i < text.length) {
    const start = i;
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i += 1;
      continue;
    }
    if (c === "(" || c === ")" || c === ",") {
      out.push({ offset: start, length: 1, token: c === "(" ? { t: "open" } : c === ")" ? { t: "close" } : { t: "comma" } });
      i += 1;
      continue;
    }
    if (c === "=" && text[i + 1] === ">") {
      out.push({ offset: start, length: 2, token: { t: "arrow" } });
      i += 2;
      continue;
    }
    if (c === "=") {
      out.push({ offset: start, length: 1, token: { t: "cmp", cmp: "=" } });
      i += 1;
      continue;
    }
    if (c === "!" && text[i + 1] === "=") {
      out.push({ offset: start, length: 2, token: { t: "cmp", cmp: "!=" } });
      i += 2;
      continue;
    }
    if (c === "<" || c === ">") {
      const orEqual = text[i + 1] === "=";
      const cmp = (c + (orEqual ? "=" : "")) as Cmp;
      out.push({ offset: start, length: orEqual ? 2 : 1, token: { t: "cmp", cmp } });
      i += orEqual ? 2 : 1;
      continue;
    }
    if (isDigit(c)) {
      while (isDigit(text[i])) i += 1;
      if (text[i] === ".") {
        i += 1;
        const fraction = i;
        while (isDigit(text[i])) i += 1;
        if (i === fraction) {
          throw new PredicateError("a number needs digits after its point", start, i - start);
        }
      }
      if (isAlpha(text[i]) || text[i] === "_") {
        while (isAlpha(text[i]) || isDigit(text[i]) || text[i] === "_") i += 1;
        throw new PredicateError("a name cannot start with a digit", start, i - start);
      }
      out.push({ offset: start, length: i - start, token: { t: "number", text: text.slice(start, i) } });
      continue;
    }
    if (isLower(c) || c === "_") {
      while (isLower(text[i]) || isDigit(text[i]) || text[i] === "_") i += 1;
      out.push({ offset: start, length: i - start, token: { t: "word", text: text.slice(start, i) } });
      continue;
    }
    const hint = c >= "A" && c <= "Z" ? " (names are lower case)" : "";
    throw new PredicateError(`unexpected character ${JSON.stringify(c)}${hint}`, start, 1);
  }
  out.push({ offset: text.length, length: 0, token: { t: "end" } });
  return out;
}

function thousandths(text: string): number {
  const [whole0, fraction = ""] = text.split(".");
  if (fraction.length > 3) {
    throw new Error("a number has at most three digits after its point");
  }
  const whole = whole0.replace(/^0+/, "");
  if (whole.length > 12) {
    throw new Error("a number up to 999999999999");
  }
  const places = [100, 10, 1];
  let frac = 0;
  for (let i = 0; i < fraction.length; i += 1) {
    frac += Number(fraction[i]) * places[i];
  }
  return (whole === "" ? 0 : Number(whole)) * 1000 + frac;
}

class Parser {
  private at = 0;
  private depth = 0;
  private readonly tokens: Spanned[];

  constructor(tokens: Spanned[]) {
    this.tokens = tokens;
  }

  peek(): Token {
    return this.tokens[this.at]?.token ?? { t: "end" };
  }

  next(): Spanned {
    const token = this.tokens[this.at] ?? { offset: 0, length: 0, token: { t: "end" } };
    if (this.at < this.tokens.length) this.at += 1;
    return token;
  }

  here(message: string): PredicateError {
    const span = this.tokens[this.at] ?? { offset: 0, length: 0 };
    return new PredicateError(message, span.offset, span.length);
  }

  isWord(word: string): boolean {
    const token = this.peek();
    return token.t === "word" && token.text === word;
  }

  enter(): void {
    this.depth += 1;
    if (this.depth > MAX_DEPTH) {
      throw this.here(`nested deeper than ${MAX_DEPTH} levels`);
    }
  }

  condition(): Cond {
    const parts = [this.conj()];
    while (this.isWord("or")) {
      this.next();
      parts.push(this.conj());
    }
    return parts.length === 1 ? parts[0] : { op: "or", parts };
  }

  conj(): Cond {
    const parts = [this.neg()];
    while (this.isWord("and")) {
      this.next();
      parts.push(this.neg());
    }
    return parts.length === 1 ? parts[0] : { op: "and", parts };
  }

  neg(): Cond {
    if (this.isWord("not")) {
      this.next();
      this.enter();
      const inner = this.neg();
      this.depth -= 1;
      return { op: "not", inner };
    }
    if (this.peek().t === "open") {
      this.next();
      this.enter();
      const inner = this.condition();
      if (this.peek().t !== "close") {
        throw this.here(`expected "and", "or" or ")", found ${describe(this.peek())}`);
      }
      this.next();
      this.depth -= 1;
      return inner;
    }
    return this.test();
  }

  test(): Cond {
    const { offset, length, token } = this.next();
    if (token.t !== "word" || KEYWORDS.has(token.text)) {
      throw new PredicateError(`expected a field, "not" or "(", found ${describe(token)}`, offset, length);
    }
    const name = token.text;
    const field = FIELDS.findIndex((def) => def.name === name);
    if (field < 0) {
      throw new PredicateError(`unknown field "${name}"`, offset, length);
    }
    const def = FIELDS[field];
    const peek = this.peek();
    if (peek.t === "cmp") {
      const span = this.next();
      if (peek.cmp !== "=" && peek.cmp !== "!=" && def.kind.type !== "number") {
        throw new PredicateError(`${peek.cmp} compares numbers; ${name} is not a number`, span.offset, span.length);
      }
      return { op: "test", field, test: { kind: "cmp", cmp: peek.cmp, value: this.literal(def) } };
    }
    if (peek.t === "word" && peek.text === "in") {
      const span = this.next();
      if (def.kind.type === "bool") {
        throw new PredicateError(`${name} is yes or no: use ${name} or not ${name}`, span.offset, span.length);
      }
      if (this.peek().t !== "open") {
        throw this.here(`expected "(" after in, found ${describe(this.peek())}`);
      }
      this.next();
      const values = [this.literal(def)];
      while (this.peek().t === "comma") {
        this.next();
        if (values.length === MAX_IN_VALUES) {
          throw this.here(`at most ${MAX_IN_VALUES} values in a list`);
        }
        values.push(this.literal(def));
      }
      if (this.peek().t !== "close") {
        throw this.here(`expected "," or ")", found ${describe(this.peek())}`);
      }
      this.next();
      return { op: "test", field, test: { kind: "in", values } };
    }
    if (def.kind.type !== "bool") {
      throw new PredicateError(`${name} is not yes or no: compare it`, offset, length);
    }
    return { op: "test", field, test: { kind: "true" } };
  }

  literal(def: FieldDef): Literal {
    const { offset, length, token } = this.next();
    const wrong = (message: string) => new PredicateError(message, offset, length);
    switch (def.kind.type) {
      case "bool":
        if (token.t === "word" && (token.text === "true" || token.text === "false")) {
          return token.text === "true";
        }
        throw wrong(`${def.name} is true or false, not ${describe(token)}`);
      case "number":
        if (token.t === "number") {
          try {
            return thousandths(token.text);
          } catch (error) {
            throw wrong((error as Error).message);
          }
        }
        throw wrong(`${def.name} is a number, not ${describe(token)}`);
      case "choice":
        if (token.t === "word" && def.kind.words.includes(token.text)) {
          return token.text;
        }
        throw wrong(`${def.name} is one of ${def.kind.words.join(", ")}; not ${describe(token)}`);
    }
  }
}

/** Parse a counter (`predicate::parse` against `FIELDS`). Throws a `PredicateError`. */
export function parsePredicate(text: string): Predicate {
  if (text.length > MAX_LENGTH) {
    throw new PredicateError(`longer than ${MAX_LENGTH} bytes`, MAX_LENGTH, 0);
  }
  const parser = new Parser(tokenize(text));
  const first = parser.peek();
  if (first.t === "end") {
    throw parser.here("empty: start with first, any or each");
  }
  if (first.t !== "word" || !["first", "any", "each"].includes(first.text)) {
    throw parser.here(`start with first, any or each, not ${describe(first)}`);
  }
  const mode = first.text as Mode;
  parser.next();
  if (parser.peek().t === "end") {
    throw parser.here("expected the opportunity after the mode");
  }
  const opportunity = parser.condition();
  let action: Cond | null = null;
  if (parser.peek().t === "arrow") {
    parser.next();
    if (parser.peek().t === "end") {
      throw parser.here('expected the action after "=>"');
    }
    action = parser.condition();
  }
  if (parser.peek().t !== "end") {
    throw parser.here(`expected "and", "or", "=>" or the end, found ${describe(parser.peek())}`);
  }
  return { mode, opportunity, action };
}

function compare(value: Val, cmp: Cmp, literal: Literal): boolean {
  if (value === null || typeof value !== typeof literal) {
    return false;
  }
  if (typeof value !== "number" && cmp !== "=" && cmp !== "!=") {
    return false;
  }
  switch (cmp) {
    case "=":
      return value === literal;
    case "!=":
      return value !== literal;
    case "<":
      return (value as number) < (literal as number);
    case "<=":
      return (value as number) <= (literal as number);
    case ">":
      return (value as number) > (literal as number);
    case ">=":
      return (value as number) >= (literal as number);
  }
}

/** Whether a condition holds for one event (`custom.rs` `holds`). */
export function holds(cond: Cond, hand: HandEvents, seat: SeatEvents, event: DecisionEvent): boolean {
  switch (cond.op) {
    case "test": {
      const value = FIELDS[cond.field].value(hand, seat, event);
      const test = cond.test;
      if (test.kind === "true") return value === true;
      if (test.kind === "cmp") return compare(value, test.cmp, test.value);
      return test.values.some((literal) => compare(value, "=", literal));
    }
    case "not":
      return !holds(cond.inner, hand, seat, event);
    case "and":
      return cond.parts.every((part) => holds(part, hand, seat, event));
    case "or":
      return cond.parts.some((part) => holds(part, hand, seat, event));
  }
}

/** Every field a condition reads, by index. */
export function condFields(cond: Cond, out: number[] = []): number[] {
  switch (cond.op) {
    case "test":
      out.push(cond.field);
      break;
    case "not":
      condFields(cond.inner, out);
      break;
    default:
      for (const part of cond.parts) condFields(part, out);
  }
  return out;
}

/** (R3.9) The predicate names a card field. */
export function readsCards(predicate: Predicate): boolean {
  const fields = condFields(predicate.opportunity);
  if (predicate.action) condFields(predicate.action, fields);
  return fields.some((index) => FIELDS[index].cards === true);
}

export interface Counts {
  made: number;
  opp: number;
}

/** One seat's `(made, opportunities)` in one hand (`CustomCounter::count`). */
export function countSeat(predicate: Predicate, hand: HandEvents, seat: SeatEvents): Counts {
  const { mode, opportunity, action } = predicate;
  const made = (event: DecisionEvent) => action === null || holds(action, hand, seat, event);
  const counts: Counts = { made: 0, opp: 0 };
  for (const event of seat.events) {
    if (!holds(opportunity, hand, seat, event)) continue;
    if (mode === "first") {
      return { made: made(event) ? 1 : 0, opp: 1 };
    }
    if (mode === "any") {
      counts.opp = 1;
      if (made(event)) {
        counts.made = 1;
        break;
      }
    } else {
      counts.opp += 1;
      counts.made += made(event) ? 1 : 0;
    }
  }
  return counts;
}

/**
 * The events `countSeat` counts as opportunities, each with whether it passes
 * the action (`CustomCounter::members`): `first` and `any` the first one,
 * `each` every one.
 */
export function members(
  predicate: Predicate,
  hand: HandEvents,
  seat: SeatEvents,
): { event: DecisionEvent; taken: boolean }[] {
  const out: { event: DecisionEvent; taken: boolean }[] = [];
  for (const event of seat.events) {
    if (!holds(predicate.opportunity, hand, seat, event)) continue;
    out.push({ event, taken: predicate.action === null || holds(predicate.action, hand, seat, event) });
    if (predicate.mode !== "each") break;
  }
  return out;
}
