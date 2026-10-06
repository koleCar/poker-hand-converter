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
import type { LessonId } from "../course";

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

export type LessonBlock =
  /** A paragraph. */
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

export type LessonOutlines = { readonly [id in LessonId]: LessonOutline };
export type LessonBodies<K extends LessonId = LessonId> = { readonly [id in K]: LessonBody };
