/**
 * The shape of one concept page's words, in one language.
 *
 * Plain strings, paragraph by paragraph: the page renders them server-side as
 * text, so there is no markup to escape and nothing to sanitise. Numbers in
 * the examples are written out by hand and checked by
 * `tests/test/learnContent.test.ts` against `lib/learn/math.ts` where a
 * formula produced them.
 *
 * The title is not here: it lives in the dictionary (`learn.titles`), because
 * the Analysis sheet links to a concept by name from the client, and the page
 * bodies are too large to ship to every screen.
 */

import type { ConceptId } from "../concepts";

/**
 * A formula's right-hand side. A string is a run of text (`"pot + call"`), an
 * array is a sequence, and `{ frac }` is a fraction drawn as numerator over
 * denominator.
 */
export type FormulaNode =
  | string
  | { readonly frac: readonly [FormulaNode, FormulaNode] }
  | { readonly sup: FormulaNode }
  | readonly FormulaNode[];

export interface Formula {
  /** The left-hand side: "Required equity". */
  name: string;
  expression: FormulaNode;
  /** The whole formula as a sentence, for screen readers: "required equity equals call divided by pot plus call". */
  spoken: string;
  /** What the symbols mean, when the expression uses any. */
  where?: readonly (readonly [symbol: string, meaning: string])[];
}

export interface ConceptExample {
  title: string;
  /** The spot, in a sentence or two. */
  setup: string;
  /** The working, one line per step. */
  steps: readonly string[];
  /** What the numbers say. */
  takeaway: string;
}

export interface ConceptText {
  /** One sentence: the index card, and the page's meta description. */
  summary: string;
  /** What it is. One to three short paragraphs. */
  definition: readonly string[];
  /** Why it matters at the table. */
  why: readonly string[];
  formulas?: readonly Formula[];
  example: ConceptExample;
  mistakes: readonly string[];
  /** One line above the interactive example: what to try with it. */
  tryIt?: string;
}

export type ConceptTexts<K extends ConceptId = ConceptId> = { readonly [id in K]: ConceptText };
