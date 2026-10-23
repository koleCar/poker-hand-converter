/**
 * Range text in and out (R5.3): the formats players paste from other tools,
 * read into one action's 169 percents, and written back.
 *
 * **Read** (`parseRange`), detected per token, mixed freely:
 *
 * - classes and the usual shorthand: `AA`, `AKs`, `AKo`, `AK` (both),
 *   `QQ+`, `22-55` (either way round), `ATs+`, `A2s-A5s`, `K9o+`, `KT+`;
 * - weights: `AKs:0.5` (PIO / Flopzilla style, 0-1; above 1 and up to 100
 *   read as a percent), and `[50]AA,KK[/50]` blocks (GTO+ / Equilab, percent);
 * - single combos, `AhKh` or `AhKh:0.5` (PIO / GTO+ exports): each class's
 *   weight is its combos' weights over its combo count, so `AhKh` alone is
 *   25 % of `AKs`;
 * - a list, one hand per line with an optional weight after a space or a tab
 *   (`AKs 0.5`, `AKs\t50%`);
 * - separators: commas, spaces, semicolons, new lines.
 *
 * Every weight ends as a whole percent (rounded half up). A class named
 * twice keeps the last weight; combos of one class add up. What cannot be
 * read is an error naming the token, never a guess.
 *
 * **Write**: `formatRange` (the shorthand, `:0.5` weights - the form PIO,
 * GTO+ and Flopzilla all read), `formatBrackets` (`[50]…[/50]`) and
 * `formatCombos` (every combo, `AhKh:0.5`).
 */
import { CLASS_COUNT, CLASS_NAMES, RANKS, classIndex, combosOf } from "./model";

export interface RangeProblem {
  code: "token" | "weight" | "bracket" | "empty";
  token: string;
}

export type RangeResult = { ok: true; percents: Uint8Array; classes: number } | { ok: false; problems: RangeProblem[] };

const SUITS = "shdc";
const rankOf = (c: string): number => RANKS.indexOf(c.toUpperCase());

/** A weight as written: 0-1 is a fraction, above 1 up to 100 a percent; `50%` a percent. */
function readWeight(text: string): number | null {
  const t = text.trim();
  const percent = t.endsWith("%");
  const n = Number(percent ? t.slice(0, -1) : t);
  if (t === "" || !Number.isFinite(n) || n < 0) return null;
  if (percent) return n <= 100 ? n / 100 : null;
  if (n <= 1) return n;
  return n <= 100 ? n / 100 : null;
}

/** Classes of a non-pair from a high rank and a run of kickers. */
function nonPairs(hi: number, loFrom: number, loTo: number, kinds: string): string[] {
  const out: string[] = [];
  for (let lo = loFrom; lo <= loTo; lo += 1) {
    for (const kind of kinds) out.push(`${RANKS[hi]}${RANKS[lo]}${kind}`);
  }
  return out;
}

/** The classes of one shorthand token, or null. */
export function expandToken(token: string): string[] | null {
  const t = token.trim();
  // A pair, a pair and up, a run of pairs.
  let m = /^([2-9TJQKA])\1(\+)?$/i.exec(t);
  if (m) {
    const r = rankOf(m[1]);
    const out: string[] = [];
    for (let k = m[2] ? 0 : r; k <= r; k += 1) out.push(`${RANKS[k]}${RANKS[k]}`);
    return out;
  }
  m = /^([2-9TJQKA])\1-([2-9TJQKA])\2$/i.exec(t);
  if (m) {
    const a = rankOf(m[1]);
    const b = rankOf(m[2]);
    const out: string[] = [];
    for (let k = Math.min(a, b); k <= Math.max(a, b); k += 1) out.push(`${RANKS[k]}${RANKS[k]}`);
    return out;
  }
  // A non-pair: AK, AKs, AKo, with + (kicker up to one below the high card), or a run.
  m = /^([2-9TJQKA])([2-9TJQKA])([so])?(\+)?$/i.exec(t);
  if (m) {
    let hi = rankOf(m[1]);
    let lo = rankOf(m[2]);
    if (hi === lo) return null;
    if (hi > lo) [hi, lo] = [lo, hi];
    const kinds = m[3] ? m[3].toLowerCase() : "so";
    return m[4] ? nonPairs(hi, hi + 1, lo, kinds) : nonPairs(hi, lo, lo, kinds);
  }
  m = /^([2-9TJQKA])([2-9TJQKA])([so])?-([2-9TJQKA])([2-9TJQKA])([so])?$/i.exec(t);
  if (m) {
    const hi = rankOf(m[1]);
    if (rankOf(m[4]) !== hi || (m[3] ?? "").toLowerCase() !== (m[6] ?? "").toLowerCase()) return null;
    const a = rankOf(m[2]);
    const b = rankOf(m[5]);
    if (a <= hi || b <= hi) return null;
    return nonPairs(hi, Math.min(a, b), Math.max(a, b), m[3] ? m[3].toLowerCase() : "so");
  }
  return null;
}

/** The class of a combo like `AhKh`, or -1. */
export function comboClass(token: string): number {
  const m = /^([2-9TJQKA])([shdc])([2-9TJQKA])([shdc])$/i.exec(token.trim());
  if (!m) return -1;
  const a = rankOf(m[1]);
  const b = rankOf(m[3]);
  const sa = m[2].toLowerCase();
  const sb = m[4].toLowerCase();
  if (a === b && sa === sb) return -1;
  if (a === b) return classIndex(`${RANKS[a]}${RANKS[a]}`);
  const [hi, lo] = a < b ? [a, b] : [b, a];
  return classIndex(`${RANKS[hi]}${RANKS[lo]}${sa === sb ? "s" : "o"}`);
}

/** One range to 169 whole percents. */
export function parseRange(text: string): RangeResult {
  const problems: RangeProblem[] = [];
  const classWeight = new Map<number, number>();
  const comboWeight = new Map<number, Map<string, number>>();

  // `[w]…[/w]` blocks first: their tokens take the block's weight.
  const chunks: Array<{ text: string; weight: number | null }> = [];
  const bracket = /\[([0-9.]+)\]([\s\S]*?)\[\/\1\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = bracket.exec(text)) !== null) {
    chunks.push({ text: text.slice(last, m.index), weight: null });
    const w = Number(m[1]);
    if (!Number.isFinite(w) || w < 0 || w > 100) problems.push({ code: "weight", token: `[${m[1]}]` });
    chunks.push({ text: m[2], weight: w / 100 });
    last = m.index + m[0].length;
  }
  chunks.push({ text: text.slice(last), weight: null });
  if (chunks.some((chunk) => /\[\/?[0-9.]*\]/.test(chunk.text))) problems.push({ code: "bracket", token: "[ ]" });

  for (const chunk of chunks) {
    // A list line "AKs 0.5" / "AKs\t50%" is one token with a weight.
    const lines = chunk.text.split(/\r?\n/);
    const tokens: string[] = [];
    for (const line of lines) {
      // "AKs 0.5" / "AKs\t50%": a hand, white space, a weight - never "TT 99", two pairs.
      const listed = /^(\S+)[ \t]+([0-9.]+%?)$/.exec(line.trim());
      if (listed && readWeight(listed[2]) !== null && !/^([2-9])\1$/.test(listed[2])) {
        tokens.push(`${listed[1]}:${listed[2]}`);
      } else {
        tokens.push(...line.trim().split(/[\s,;]+/).filter(Boolean));
      }
    }
    for (const raw of tokens) {
      const [body, weightText, extra] = raw.split(":");
      if (extra !== undefined) {
        problems.push({ code: "token", token: raw });
        continue;
      }
      let weight = chunk.weight ?? 1;
      if (weightText !== undefined) {
        const w = readWeight(weightText);
        if (w === null) {
          problems.push({ code: "weight", token: raw });
          continue;
        }
        weight = chunk.weight === null ? w : chunk.weight * w;
      }
      const combo = comboClass(body);
      if (combo >= 0) {
        const map = comboWeight.get(combo) ?? new Map<string, number>();
        const norm = body.trim();
        map.set(`${norm[0].toUpperCase()}${norm[1].toLowerCase()}${norm[2].toUpperCase()}${norm[3].toLowerCase()}`, weight);
        comboWeight.set(combo, map);
        continue;
      }
      const classes = expandToken(body);
      if (!classes) {
        problems.push({ code: "token", token: raw });
        continue;
      }
      for (const name of classes) classWeight.set(classIndex(name), weight);
    }
  }
  if (problems.length > 0) return { ok: false, problems };

  const percents = new Uint8Array(CLASS_COUNT);
  let classes = 0;
  for (let i = 0; i < CLASS_COUNT; i += 1) {
    let w = classWeight.get(i);
    const combos = comboWeight.get(i);
    if (combos) {
      let sum = 0;
      for (const v of combos.values()) sum += v;
      w = Math.min(1, (w ?? 0) + sum / combosOf(i));
    }
    if (w === undefined) continue;
    percents[i] = Math.min(100, Math.floor(w * 100 + 0.5 + 1e-9));
    if (percents[i] > 0) classes += 1;
  }
  return { ok: true, percents, classes };
}

/* ----------------------------------------------------------------- write - */

/** The shorthand of a set of classes at one weight, strongest first: `QQ+, 99-66, ATs+, A5s-A2s, KQo`. */
export function shorthand(members: ReadonlySet<number>): string[] {
  const out: string[] = [];
  // Pairs: runs along the diagonal.
  let r = 0;
  while (r < 13) {
    if (!members.has(r * 13 + r)) {
      r += 1;
      continue;
    }
    let end = r;
    while (end + 1 < 13 && members.has((end + 1) * 13 + end + 1)) end += 1;
    const top = `${RANKS[r]}${RANKS[r]}`;
    const low = `${RANKS[end]}${RANKS[end]}`;
    out.push(r === end ? top : r === 0 ? `${low}+` : `${top}-${low}`);
    r = end + 1;
  }
  // Non-pairs: per high card and kind, runs of kickers.
  for (const kind of ["s", "o"] as const) {
    for (let hi = 0; hi < 12; hi += 1) {
      let lo = hi + 1;
      while (lo < 13) {
        const at = (k: number) => (kind === "s" ? hi * 13 + k : k * 13 + hi);
        if (!members.has(at(lo))) {
          lo += 1;
          continue;
        }
        let end = lo;
        while (end + 1 < 13 && members.has(at(end + 1))) end += 1;
        const name = (k: number) => `${RANKS[hi]}${RANKS[k]}${kind}`;
        out.push(lo === end ? name(lo) : lo === hi + 1 ? `${name(end)}+` : `${name(lo)}-${name(end)}`);
        lo = end + 1;
      }
    }
  }
  return out;
}

/** Groups of classes by weight, the full ones first, then heavier weights first. */
function byWeight(percents: Uint8Array): Array<{ percent: number; members: Set<number> }> {
  const groups = new Map<number, Set<number>>();
  for (let i = 0; i < CLASS_COUNT; i += 1) {
    const p = percents[i];
    if (p <= 0) continue;
    const set = groups.get(p) ?? new Set<number>();
    set.add(i);
    groups.set(p, set);
  }
  return [...groups.entries()].sort((a, b) => b[0] - a[0]).map(([percent, members]) => ({ percent, members }));
}

const fraction = (percent: number) => String(percent / 100);

/** `AA,KK,AKs,AQs:0.5`: the shorthand with PIO-style weights; empty for an empty range. */
export function formatRange(percents: Uint8Array): string {
  const parts: string[] = [];
  for (const { percent, members } of byWeight(percents)) {
    for (const token of shorthand(members)) parts.push(percent === 100 ? token : `${token}:${fraction(percent)}`);
  }
  return parts.join(",");
}

/** `AA,KK,[50]AQs,AJs[/50]`: GTO+ / Equilab blocks. */
export function formatBrackets(percents: Uint8Array): string {
  const parts: string[] = [];
  for (const { percent, members } of byWeight(percents)) {
    const tokens = shorthand(members).join(",");
    parts.push(percent === 100 ? tokens : `[${percent}]${tokens}[/${percent}]`);
  }
  return parts.join(",");
}

/** Every combo of the range, `AhKh:0.5` (weight 1 written bare). */
export function formatCombos(percents: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < CLASS_COUNT; i += 1) {
    const p = percents[i];
    if (p <= 0) continue;
    const name = CLASS_NAMES[i];
    const suffix = p === 100 ? "" : `:${fraction(p)}`;
    const a = name[0];
    const b = name[1];
    if (name.length === 2) {
      for (let x = 0; x < 4; x += 1) {
        for (let y = x + 1; y < 4; y += 1) parts.push(`${a}${SUITS[x]}${b}${SUITS[y]}${suffix}`);
      }
    } else if (name[2] === "s") {
      for (const s of SUITS) parts.push(`${a}${s}${b}${s}${suffix}`);
    } else {
      for (const x of SUITS) {
        for (const y of SUITS) if (x !== y) parts.push(`${a}${x}${b}${y}${suffix}`);
      }
    }
  }
  return parts.join(",");
}
