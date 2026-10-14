/**
 * Displayed statistics: the definitions of `config/stats/` evaluated over
 * summed counters (docs/RAIL-PLAN.md R2.4, docs/STATS-SPEC.md §13).
 *
 * The ~90 counters stay code (`types.ts` and the walks); what is *shown* -
 * VPIP, 3-bet, bb/100 - is data: a formula over the counters, a format,
 * colour bands, the sample behind the value, labels in every language, and
 * default HUD membership. The same file is read by the desktop app and the
 * HUD in Rust (`core/rail-config` parses and validates it, `rail_stats::display`
 * evaluates it), and both print the same digits:
 *
 * - **Arithmetic is JavaScript's.** Every input is a `number` (counter and
 *   money sums are integers far below 2^53, so exact); every operator is one
 *   double operation, in the formula's order. Rust performs the same
 *   operations in `JsNumber`. So `pct(three_bet, three_bet_opp)` is
 *   `rates.ts`'s `(made * 100) / opp` bit for bit - and the order matters:
 *   `(23 * 100) / 80` is 28.75 and prints "28.8" at one decimal,
 *   `(23 / 80) * 100` is 28.749999999999996 and prints "28.7".
 * - **Text is what `Intl.NumberFormat` prints** at that many minimum and
 *   maximum fraction digits (`formatFixed`): the shortest decimal that reads
 *   back as the double (`String(x)`), rounded half away from zero, a minus
 *   sign on any negative value (`-0.04` -> "-0.0"). Not `toFixed`, which
 *   rounds the double's exact binary value (`(-0.15).toFixed(1)` is "-0.1",
 *   the web prints "-0.2"). A component may localise the decimal mark without
 *   changing a digit.
 * - **No value is `null`**: a division by zero, `pct` over no opportunities
 *   (`opp > 0` fails, as in `rates.ts`), an input the caller does not have
 *   (`evNetBbMilli` outside the hero's totals), a result that is not finite.
 *
 * The grammar (`core/rail-config/src/stats/formula.rs` has the same one):
 *
 * ```
 * expr  := term (("+" | "-") term)*
 * term  := unary (("*" | "/") unary)*
 * unary := "-" unary | atom
 * atom  := number | name | ("pct" | "sum") "(" expr ("," expr)* ")" | "(" expr ")"
 * ```
 *
 * `pct(made, opportunities)` is `made * 100 / opportunities`; `sum(a, b, c)`
 * is `(a + b) + c`. No other functions, no comparisons; the only names are the
 * counters (`COUNTER_KEYS`), the money columns (`MONEY_KEYS`), `money_hands`
 * and `ev_net_bb_milli`.
 *
 * Pure: no framework, no I/O. `definitions.ts` holds the shipped file.
 */

import type { StatsTotals } from "./rates";
import { MAX_SAMPLE_MIN, sampleReliability, wilson, type RateInterval, type Reliability } from "./reliability";
import { COUNTER_KEYS, MONEY_KEYS, type CounterKey, type MoneyKey } from "./types";

/* ---------------------------------------------------------------- shape - */

export type StatGroup = "preflop" | "postflop" | "showdown" | "results";
export type StatPlayers = "any" | "hero";
export type StatUnit = "percent" | "bb_per_100" | "bb" | "ratio" | "count" | "money";
export type StatTone = "very-low" | "low" | "normal" | "high" | "very-high";
export type HudPlace = "panel" | "popup" | "none";

/** A string in every language the web and the app speak (`LOCALES`). */
export interface StatText {
  en: string;
  hr: string;
}

export interface StatBand {
  /** Values below this; absent on the last band, which holds the rest. */
  below?: number;
  tone: StatTone;
}

/** One definition, as `config/stats/stats.schema.json` describes it. */
export interface StatDefinition {
  id: string;
  group: StatGroup;
  players: StatPlayers;
  label: StatText;
  name: StatText;
  description: StatText;
  formula: string;
  format: { unit: StatUnit; decimals: number };
  sample: { of?: string; min: number };
  bands: StatBand[];
  hud: HudPlace;
}

export interface StatsFile {
  $schema?: string;
  version: number;
  stats: StatDefinition[];
}

/** The `version` of a stats file this build reads. */
export const STATS_FILE_VERSION = 1;

/** The inputs that are neither counters nor money columns. */
export const EXTRA_NAMES = ["money_hands", "ev_net_bb_milli"] as const;
/** The inputs that exist for the hero's totals only. */
export const HERO_ONLY_NAMES: readonly string[] = ["ev_net_bb_milli"];

/** Every name a formula may read. */
export const VARIABLE_NAMES: readonly string[] = [...COUNTER_KEYS, ...MONEY_KEYS, ...EXTRA_NAMES];

/**
 * What a formula reads: `aggregate`'s totals, and the hero's all-in-EV result
 * over the money rows (`net_bb_milli` with each evaluated all-in's luck taken
 * out) when the caller has it.
 */
export interface DisplaySums extends StatsTotals {
  evNetBbMilli?: number | null;
}

/* -------------------------------------------------------------- formula - */

export type Expr =
  | { kind: "number"; text: string }
  | { kind: "name"; name: string }
  | { kind: "neg"; inner: Expr }
  | { kind: "binary"; op: "+" | "-" | "*" | "/"; left: Expr; right: Expr }
  | { kind: "pct"; made: Expr; opp: Expr }
  | { kind: "sum"; terms: Expr[] };

/** The longest formula accepted, and the deepest nesting. */
export const MAX_FORMULA_LENGTH = 1000;
export const MAX_FORMULA_DEPTH = 32;

export class FormulaError extends Error {
  /** The UTF-8 byte offset of the problem, as the Rust parser reports it. */
  readonly offset: number;
  readonly reason: string;

  constructor(offset: number, reason: string) {
    super(`${reason} at offset ${offset}`);
    this.name = "FormulaError";
    this.offset = offset;
    this.reason = reason;
  }
}

type Token =
  | { kind: "number"; text: string }
  | { kind: "name"; text: string }
  | { kind: "(" | ")" | "," | "+" | "-" | "*" | "/" | "end" };

function describe(token: Token): string {
  switch (token.kind) {
    case "number":
      return `number ${token.text}`;
    case "name":
      return `name ${token.text}`;
    case "end":
      return "the end";
    default:
      return `"${token.kind}"`;
  }
}

const isDigit = (c: string) => c >= "0" && c <= "9";
const isLower = (c: string) => c >= "a" && c <= "z";
const isAlpha = (c: string) => isLower(c) || (c >= "A" && c <= "Z");

function tokenize(text: string): Array<[number, Token]> {
  const out: Array<[number, Token]> = [];
  let i = 0;
  while (i < text.length) {
    const start = i;
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i += 1;
      continue;
    }
    if ("(),+-*/".includes(c)) {
      out.push([start, { kind: c as "(" }]);
      i += 1;
      continue;
    }
    if (isDigit(c)) {
      while (i < text.length && isDigit(text[i])) i += 1;
      if (text[i] === ".") {
        i += 1;
        const fraction = i;
        while (i < text.length && isDigit(text[i])) i += 1;
        if (i === fraction) throw new FormulaError(start, "a number needs digits after its point");
      }
      if (i < text.length && (isAlpha(text[i]) || text[i] === "_")) {
        throw new FormulaError(start, "a name cannot start with a digit");
      }
      out.push([start, { kind: "number", text: text.slice(start, i) }]);
      continue;
    }
    if (isLower(c) || c === "_") {
      while (i < text.length && (isLower(text[i]) || isDigit(text[i]) || text[i] === "_")) i += 1;
      out.push([start, { kind: "name", text: text.slice(start, i) }]);
      continue;
    }
    // The UTF-8 byte offset, as the Rust parser reports it.
    const offset = new TextEncoder().encode(text.slice(0, start)).length;
    const shown = String.fromCodePoint(text.codePointAt(start) ?? 63);
    throw new FormulaError(offset, `unexpected character '${shown}'`);
  }
  out.push([text.length, { kind: "end" }]);
  return out;
}

/** Parse a formula: the grammar, the functions and their arity, the bounds. Names are not checked. */
export function parseFormula(text: string): Expr {
  if (new TextEncoder().encode(text).length > MAX_FORMULA_LENGTH) {
    throw new FormulaError(MAX_FORMULA_LENGTH, `longer than ${MAX_FORMULA_LENGTH} bytes`);
  }
  const tokens = tokenize(text);
  let at = 0;
  let depth = 0;
  const peek = (): Token => tokens[at]?.[1] ?? { kind: "end" };
  const offset = (): number => tokens[at]?.[0] ?? 0;
  const next = (): Token => {
    const token = peek();
    if (at < tokens.length) at += 1;
    return token;
  };
  const enter = () => {
    depth += 1;
    if (depth > MAX_FORMULA_DEPTH) {
      throw new FormulaError(offset(), `nested deeper than ${MAX_FORMULA_DEPTH} levels`);
    }
  };
  const expect = (kind: Token["kind"], what: string) => {
    if (peek().kind !== kind) throw new FormulaError(offset(), `expected ${what}, found ${describe(peek())}`);
    next();
  };

  const expr = (): Expr => {
    let left = term();
    for (let token = peek(); token.kind === "+" || token.kind === "-"; token = peek()) {
      next();
      left = { kind: "binary", op: token.kind, left, right: term() };
    }
    return left;
  };
  const term = (): Expr => {
    let left = unary();
    for (let token = peek(); token.kind === "*" || token.kind === "/"; token = peek()) {
      next();
      left = { kind: "binary", op: token.kind, left, right: unary() };
    }
    return left;
  };
  const unary = (): Expr => {
    if (peek().kind === "-") {
      next();
      enter();
      const inner = unary();
      depth -= 1;
      return { kind: "neg", inner };
    }
    return atom();
  };
  const atom = (): Expr => {
    const start = offset();
    const token = next();
    if (token.kind === "number") return { kind: "number", text: token.text };
    if (token.kind === "name") {
      if (peek().kind !== "(") return { kind: "name", name: token.text };
      next();
      enter();
      const args = [expr()];
      while (peek().kind === ",") {
        next();
        args.push(expr());
      }
      expect(")", '"," or ")"');
      depth -= 1;
      if (token.text === "pct") {
        if (args.length !== 2) {
          throw new FormulaError(start, `pct takes 2 arguments (made, opportunities), not ${args.length}`);
        }
        return { kind: "pct", made: args[0], opp: args[1] };
      }
      if (token.text === "sum") return { kind: "sum", terms: args };
      throw new FormulaError(start, `unknown function ${JSON.stringify(token.text)} (pct and sum exist)`);
    }
    if (token.kind === "(") {
      enter();
      const inner = expr();
      expect(")", '")"');
      depth -= 1;
      return inner;
    }
    throw new FormulaError(start, `expected a number, a name or "(", found ${describe(token)}`);
  };

  if (peek().kind === "end") throw new FormulaError(offset(), "empty formula");
  const result = expr();
  if (peek().kind !== "end") {
    throw new FormulaError(offset(), `expected an operator or the end, found ${describe(peek())}`);
  }
  return result;
}

/** Every name a formula reads, in order of appearance. */
export function formulaNames(expr: Expr): string[] {
  switch (expr.kind) {
    case "number":
      return [];
    case "name":
      return [expr.name];
    case "neg":
      return formulaNames(expr.inner);
    case "binary":
      return [...formulaNames(expr.left), ...formulaNames(expr.right)];
    case "pct":
      return [...formulaNames(expr.made), ...formulaNames(expr.opp)];
    case "sum":
      return expr.terms.flatMap(formulaNames);
  }
}

/** Fully parenthesised, as the Rust `Display` prints it: shows how a formula was parsed. */
export function printFormula(expr: Expr): string {
  switch (expr.kind) {
    case "number":
      return expr.text;
    case "name":
      return expr.name;
    case "neg":
      return `(-${printFormula(expr.inner)})`;
    case "binary":
      return `(${printFormula(expr.left)} ${expr.op} ${printFormula(expr.right)})`;
    case "pct":
      return `pct(${printFormula(expr.made)}, ${printFormula(expr.opp)})`;
    case "sum":
      return `sum(${expr.terms.map(printFormula).join(", ")})`;
  }
}

/* ----------------------------------------------------------- evaluation - */

const COUNTER_SET = new Set<string>(COUNTER_KEYS);
const MONEY_SET = new Set<string>(MONEY_KEYS);

function input(name: string, sums: DisplaySums): number | null {
  if (COUNTER_SET.has(name)) return sums.counters[name as CounterKey];
  if (MONEY_SET.has(name)) return sums.money[name as MoneyKey];
  if (name === "money_hands") return sums.moneyHands;
  if (name === "ev_net_bb_milli") return sums.evNetBbMilli ?? null;
  return null;
}

const finite = (value: number): number | null => (Number.isFinite(value) ? value : null);

/** Evaluate a parsed formula; null when it has no value (see the header). */
export function evaluate(expr: Expr, sums: DisplaySums): number | null {
  switch (expr.kind) {
    case "number":
      return Number(expr.text);
    case "name":
      return input(expr.name, sums);
    case "neg": {
      const inner = evaluate(expr.inner, sums);
      return inner === null ? null : finite(-inner);
    }
    case "binary": {
      const a = evaluate(expr.left, sums);
      const b = evaluate(expr.right, sums);
      if (a === null || b === null) return null;
      if (expr.op === "+") return finite(a + b);
      if (expr.op === "-") return finite(a - b);
      if (expr.op === "*") return finite(a * b);
      return b === 0 ? null : finite(a / b);
    }
    case "pct": {
      const made = evaluate(expr.made, sums);
      const opp = evaluate(expr.opp, sums);
      if (made === null || opp === null || !(opp > 0)) return null;
      return finite((made * 100) / opp);
    }
    case "sum": {
      let total = 0;
      for (const [i, term] of expr.terms.entries()) {
        const value = evaluate(term, sums);
        if (value === null) return null;
        total = i === 0 ? value : total + value;
        if (!Number.isFinite(total)) return null;
      }
      return total;
    }
  }
}

/** A definition with its formulas parsed. */
export interface DisplayStat {
  def: StatDefinition;
  formula: Expr;
  /** The sample size: `sample.of`, or the opportunities of a `pct` formula. */
  sample: Expr;
}

/** A statistic as shown. */
export interface Shown {
  value: number | null;
  /** `formatFixed(value, decimals)`; null without a value, and for money without a currency. */
  text: string | null;
  tone: StatTone | null;
  sample: number | null;
  /** The sample reaches `sample.min`: shown at full opacity. */
  full: boolean;
  /** `statReliability`: the level, the opacity, a rate's interval and its text. */
  reliability: StatReliability;
}

/** How far to trust a value (R2.5; `reliability.ts`). */
export interface StatReliability {
  /** `ok` exactly when `full`. */
  level: Reliability;
  /** 1 from `sample.min`, down to `OPACITY_FLOOR` (0.6) with no sample. */
  opacity: number;
  /** A rate's 95% Wilson interval in percentage points; null for other statistics. */
  interval: RateInterval | null;
  /** The bounds as text, at the definition's decimals (`formatFixed`). */
  intervalText: { low: string; high: string } | null;
}

export function statValue(stat: DisplayStat, sums: DisplaySums): number | null {
  return evaluate(stat.formula, sums);
}

/**
 * `{ made, opportunities }` of a `pct(made, opportunities)` definition: the
 * inputs of a rate's confidence interval (R2.5). Null for other formulas.
 */
export function statRate(stat: DisplayStat, sums: DisplaySums): { made: number; opportunities: number } | null {
  if (stat.formula.kind !== "pct") return null;
  const made = evaluate(stat.formula.made, sums);
  const opportunities = evaluate(stat.formula.opp, sums);
  return made === null || opportunities === null ? null : { made, opportunities };
}

export function statSample(stat: DisplayStat, sums: DisplaySums): number | null {
  return evaluate(stat.sample, sums);
}

/** Whether the sample reaches `sample.min` (always, when that is 0). */
export function statFull(stat: DisplayStat, sums: DisplaySums): boolean {
  const min = stat.def.sample.min;
  if (min === 0) return true;
  const sample = statSample(stat, sums);
  return sample !== null && !(sample < min);
}

/**
 * The level and opacity of the value's sample against `sample.min`, and for
 * a `pct(made, opportunities)` its Wilson interval (`reliability.ts`).
 */
export function statReliability(stat: DisplayStat, sums: DisplaySums): StatReliability {
  const { level, opacity } = sampleReliability(statSample(stat, sums), stat.def.sample.min);
  const rate = statRate(stat, sums);
  const interval = rate === null ? null : wilson(rate.made, rate.opportunities);
  const decimals = stat.def.format.decimals;
  return {
    level,
    opacity,
    interval,
    intervalText:
      interval === null
        ? null
        : { low: formatFixed(interval.low, decimals), high: formatFixed(interval.high, decimals) },
  };
}

/** The value as text; money in major units of `minorUnits`. */
export function statText(stat: DisplayStat, value: number, minorUnits: number | null = null): string | null {
  const { unit, decimals } = stat.def.format;
  if (unit === "money") {
    return minorUnits === null ? null : formatFixed(value / 10 ** minorUnits, decimals);
  }
  return formatFixed(value, decimals);
}

/** "999" + 1 = "1000", on decimal digit strings. */
function increment(digits: string): string {
  const out = digits.split("");
  for (let i = out.length - 1; i >= 0; i -= 1) {
    if (out[i] !== "9") {
      out[i] = String(Number(out[i]) + 1);
      return out.join("");
    }
    out[i] = "0";
  }
  return `1${out.join("")}`;
}

/**
 * `value` with exactly `decimals` digits after the point, as
 * `Intl.NumberFormat` prints it with `minimumFractionDigits` and
 * `maximumFractionDigits` both `decimals` and no grouping: the shortest
 * round-trip decimal (`String(value)`) rounded half away from zero, in plain
 * notation, with a minus sign whenever the value is negative (-0 included).
 * `rail_stats::display::format_fixed` is the same function.
 */
export function formatFixed(value: number, decimals: number): string {
  const negative = value < 0 || Object.is(value, -0);
  const [mantissa, exponentText] = String(Math.abs(value)).split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  const digits = whole + fraction;
  // value = digits * 10^(exponent - fraction.length); shift it by `decimals`.
  const shift = Number(exponentText ?? "0") - fraction.length + decimals;
  let scaled: string;
  if (shift >= 0) {
    scaled = digits + "0".repeat(shift);
  } else if (-shift > digits.length) {
    scaled = "0";
  } else {
    const cut = digits.length + shift;
    const kept = digits.slice(0, cut) || "0";
    scaled = digits[cut] >= "5" ? increment(kept) : kept;
  }
  const padded = scaled.replace(/^0+(?=\d)/, "").padStart(decimals + 1, "0");
  const text = decimals === 0 ? padded : `${padded.slice(0, -decimals)}.${padded.slice(-decimals)}`;
  return negative ? `-${text}` : text;
}

/** The colour band the (unrounded) value falls in. */
export function statTone(stat: DisplayStat, value: number): StatTone | null {
  const band = stat.def.bands.find((b) => b.below === undefined || value < b.below);
  return band ? band.tone : null;
}

export function showStat(stat: DisplayStat, sums: DisplaySums, minorUnits: number | null = null): Shown {
  const value = statValue(stat, sums);
  return {
    value,
    text: value === null ? null : statText(stat, value, minorUnits),
    tone: value === null ? null : statTone(stat, value),
    sample: statSample(stat, sums),
    full: statFull(stat, sums),
    reliability: statReliability(stat, sums),
  };
}

/* -------------------------------------------------------------- loading - */

/**
 * Parse every formula of a stats file and check its names, ids and bands:
 * the checks `core/rail-config` makes (the JSON Schema itself is checked by
 * `tests/test/statDisplay.test.ts`). Throws on the first problem.
 */
export function compileStats(file: StatsFile): DisplayStat[] {
  if (file.version !== STATS_FILE_VERSION) {
    throw new Error(`stats file version ${file.version}, expected ${STATS_FILE_VERSION}`);
  }
  const names = new Set(VARIABLE_NAMES);
  const ids = new Set<string>();
  return file.stats.map((def) => {
    const fail = (message: string): never => {
      throw new Error(`${def.id}: ${message}`);
    };
    if (ids.has(def.id)) fail("duplicate id");
    ids.add(def.id);
    const parse = (what: string, text: string): Expr => {
      let expr: Expr;
      try {
        expr = parseFormula(text);
      } catch (error) {
        return fail(`${what} ${JSON.stringify(text)} does not parse: ${(error as Error).message}`);
      }
      for (const name of formulaNames(expr)) {
        if (!names.has(name)) fail(`${what} reads ${JSON.stringify(name)}, which is not a counter`);
        if (HERO_ONLY_NAMES.includes(name) && def.players !== "hero") {
          fail(`${what} reads ${JSON.stringify(name)}, which exists for the hero only`);
        }
      }
      return expr;
    };
    const formula = parse("the formula", def.formula);
    let sample: Expr;
    if (def.sample.of !== undefined) {
      sample = parse("the sample", def.sample.of);
    } else if (formula.kind === "pct") {
      sample = formula.opp;
    } else {
      return fail('the formula is not pct(made, opportunities), so the sample needs "of"');
    }
    if (!Number.isSafeInteger(def.sample.min) || def.sample.min < 0 || def.sample.min > MAX_SAMPLE_MIN) {
      fail(`sample.min ${def.sample.min} is not a whole number from 0 to ${MAX_SAMPLE_MIN}`);
    }
    let previous = -Infinity;
    def.bands.forEach((band, i) => {
      const last = i === def.bands.length - 1;
      if (last !== (band.below === undefined)) fail("only the last band omits \"below\"");
      if (band.below !== undefined) {
        if (!(band.below > previous)) fail(`band ${i}'s "below" is not above the previous one`);
        previous = band.below;
      }
    });
    return { def, formula, sample };
  });
}

/** The definition with this id, or an error naming it: a typo is a bug, not a missing tile. */
export function statById(stats: readonly DisplayStat[], id: string): DisplayStat {
  const stat = stats.find((s) => s.def.id === id);
  if (!stat) throw new Error(`no statistic ${JSON.stringify(id)} in the definitions`);
  return stat;
}
