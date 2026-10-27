/**
 * The shape of a lesson's words, in one language (Learn L1).
 *
 * Like the concept pages (`../content/types.ts`): plain strings, paragraph by
 * paragraph, rendered as text by the server — nothing to escape, nothing to
 * sanitise. The structure (sections, blocks, the widgets and checkpoints in
 * them, the right answers) must be the same in every language; only the words
 * differ. `tests/test/course.test.ts` holds the languages to that, checks
 * every widget preset, and recomputes every number a lesson states.
 *
 * **Numbers.** A lesson states only plain arithmetic (worked in the text and
 * recomputed by the tests) or numbers a widget computes on screen at runtime.
 * It never quotes a chart's or a solver's frequency, and no material from
 * other training products is used.
 *
 * The title is not here: it is in the dictionary (`course.titles`), because
 * the course map and the study plan name lessons client-side.
 */

import type { WidgetPreset } from "../concepts";
import type { Formula } from "../content/types";
import type { LessonId, ReferenceId } from "../course";

/** The formulas a lesson's numbers may come from: `lib/learn/math.ts`, by name (`checks.ts` maps them). */
export type MathFn =
  | "requiredEquity"
  | "potOddsRatio"
  | "callEv"
  | "alpha"
  | "mdf"
  | "bluffShare"
  | "valuePerBluff"
  | "bluffEv"
  | "bluffCatcherEv"
  | "spr"
  | "geometricBet"
  | "allFold"
  | "mdfSplit"
  | "marginOfError"
  | "sampleNeeded"
  | "product"
  | "sum"
  | "ratio";

/**
 * A number a lesson states, with the formula and inputs that produce it. The
 * tests recompute `fn(...args)` and require `value` within `tolerance`
 * (default: half of the last digit `value` is written with, at least 0.0005).
 */
export interface MathCheck {
  fn: MathFn;
  args: readonly number[];
  value: number;
  tolerance?: number;
}

/** A "predict, then reveal" question: the reader commits to an answer before the explanation (and widget) opens. */
export interface Checkpoint {
  question: string;
  /** Two to five answers. */
  options: readonly string[];
  /** Index into `options`. */
  answer: number;
  /** Why, shown after the reader has answered. */
  explain: string;
  /** A calculator that shows the truth after the answer, opened on the question's numbers. */
  reveal?: WidgetPreset;
  /** The arithmetic behind the right answer, when it is a number. */
  math?: MathCheck;
}

/**
 * A paragraph or list item may link a reference page inline, the first time a
 * lesson uses its term: `[[pot-odds|pot odds]]` renders "pot odds" as a link
 * to `/learn/reference/pot-odds` (`refLinks` parses it; the tests hold every
 * target to a `ReferenceId`, and English and Croatian to the same targets).
 * Outline goals may do the same. Nowhere else: summaries, captions and
 * checkpoints are plain text.
 */
export const REF_LINK = /\[\[([a-z0-9-]+)\|([^\]]+)\]\]/g;

/** A text split into plain runs and reference links, in order. */
export function refLinks(text: string): Array<{ text: string; ref?: string }> {
  const out: Array<{ text: string; ref?: string }> = [];
  let at = 0;
  for (const match of text.matchAll(REF_LINK)) {
    if (match.index! > at) out.push({ text: text.slice(at, match.index) });
    out.push({ text: match[2], ref: match[1] });
    at = match.index! + match[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

/** The text without its link markup: what a plain-text reader (a meta description) sees. */
export function plainText(text: string): string {
  return text.replace(REF_LINK, "$2");
}

export type LessonBlock =
  /** A paragraph (may hold `[[ref|label]]` links). */
  | string
  | { readonly list: readonly string[] }
  | { readonly widget: WidgetPreset; readonly caption?: string }
  | { readonly checkpoint: Checkpoint }
  | { readonly formula: Formula }
  /** An honesty banner: what the engine cannot solve yet, in the analysis' own terms. */
  | { readonly note: { readonly tone: "conceptual" | "approximate"; readonly text: string } };

export interface LessonSection {
  heading: string;
  blocks: readonly LessonBlock[];
}

/** Every lesson's outline, written or not: what the map and a "coming soon" page show. */
export interface LessonOutline {
  /** One sentence: the map card, and the page's meta description. */
  summary: string;
  /** Three to five learning goals. */
  goals: readonly string[];
}

/** A written lesson's body. */
export interface LessonBody {
  sections: readonly LessonSection[];
  /** Rules of thumb to take away, and when each kind of rule breaks. */
  heuristics: { readonly rules: readonly string[]; readonly breaks: readonly string[] };
  /** One or two lines above each exercise, by exercise id (`LessonMeta.exercises`). */
  exercises: Readonly<Record<string, string>>;
  /** Every computed number the sections state, with how it is computed (same in every language). */
  checks: readonly MathCheck[];
}

/** A page with words in `lessons/`: a lesson on the map, or a reference page (L1's M0–M2). */
export type PageId = LessonId | ReferenceId;

export type LessonOutlines = { readonly [id in PageId]: LessonOutline };
export type LessonBodies<K extends PageId = LessonId> = { readonly [id in K]: LessonBody };
