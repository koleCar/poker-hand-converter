/**
 * The command palette's fuzzy match (R2.8): the query's characters in order
 * anywhere in the text ("gtrep" finds "Go to Reports"), case and diacritics
 * ignored ("cas" finds "Čas", "nocni" finds "noćni"). A score orders the
 * matches: the start of the text and of its words count most, then runs of
 * consecutive characters; a gap costs a little. Framework-free, so a surface
 * can rank its own items (the desktop app's commands, later the web's).
 */

/** One character's search form: lower case, without its diacritic. */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Where a match starts a word: the text's start, or after a space or punctuation. */
function wordStart(text: string, index: number): boolean {
  if (index === 0) return true;
  const before = text[index - 1] ?? " ";
  return /[\s\-_/:.,·#(]/u.test(before);
}

export interface FuzzyMatch {
  /** Higher is better. */
  score: number;
  /** The matched characters' indexes in the text, ascending. */
  indexes: number[];
}

/**
 * `query` against `text`; `null` when the query's characters are not all in
 * the text in order. An empty query matches everything with score 0.
 *
 * Greedy from the left with one look-ahead: each query character prefers a
 * word start or the character right after the previous match over the first
 * occurrence, which is what a reader expects of "gr" in "Go to Reports".
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = fold(query.trim());
  if (q === "") return { score: 0, indexes: [] };
  const folded = fold(text);
  // Folding can change a string's length (a decomposed letter); fall back to
  // plain lower case for such texts so the indexes stay the text's.
  const t = folded.length === text.length ? folded : text.toLowerCase();
  const indexes: number[] = [];
  let from = 0;
  let score = 0;
  let previous = -2;
  for (const char of q) {
    if (char === " ") continue;
    let found = -1;
    // The next occurrence that is adjacent or starts a word, else the next one.
    let first = -1;
    for (let i = from; i < t.length; i++) {
      if (t[i] !== char) continue;
      if (first < 0) first = i;
      if (i === previous + 1 || wordStart(t, i)) {
        found = i;
        break;
      }
    }
    if (found < 0) found = first;
    if (found < 0) return null;
    if (found === previous + 1) score += 6;
    if (wordStart(t, found)) score += found === 0 ? 10 : 8;
    score -= Math.min(3, found - from) * 0.5;
    indexes.push(found);
    previous = found;
    from = found + 1;
  }
  // A whole-word or prefix hit beats a scattered one of the same letters.
  if (t.startsWith(q)) score += 12;
  else if (t.includes(q)) score += 6;
  // Shorter texts first among equals.
  score -= t.length * 0.01;
  return { score, indexes };
}

export interface Rankable {
  label: string;
  /** Other words the item answers to (a screen's other name, a command's synonyms). */
  keywords?: readonly string[];
}

/**
 * The items `query` matches, best first (ties keep their order). An item
 * matches on its label or on one of its keywords; a keyword hit counts a
 * little less than the same hit on the label.
 */
export function rankItems<T extends Rankable>(query: string, items: readonly T[]): T[] {
  if (query.trim() === "") return [...items];
  const scored: { item: T; score: number; order: number }[] = [];
  items.forEach((item, order) => {
    let best = fuzzyMatch(query, item.label)?.score ?? null;
    for (const keyword of item.keywords ?? []) {
      const match = fuzzyMatch(query, keyword);
      if (match !== null && (best === null || match.score - 2 > best)) best = match.score - 2;
    }
    if (best !== null) scored.push({ item, score: best, order });
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.map(({ item }) => item);
}
