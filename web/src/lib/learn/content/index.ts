/**
 * The concept pages' words, by locale.
 *
 * **Server-only by use, not by import.** These are the long texts — tens of
 * kilobytes per language — and only the server components under
 * `app/analysis/learn/` read them, so they never reach a client bundle. The
 * client knows a concept by its title alone (`learn.titles` in the
 * dictionary). Nothing here imports `server-only`, so `tests/test/` can check
 * the numbers in the examples under plain Node.
 */

import type { Locale } from "../../i18n/types";
import type { ConceptId } from "../concepts";
import { bettingEn } from "./betting.en";
import { bettingHr } from "./betting.hr";
import { foundationsEn } from "./foundations.en";
import { foundationsHr } from "./foundations.hr";
import { preflopEn } from "./preflop.en";
import { preflopHr } from "./preflop.hr";
import { rangesEn } from "./ranges.en";
import { rangesHr } from "./ranges.hr";
import type { ConceptText, ConceptTexts } from "./types";

const en: ConceptTexts = { ...foundationsEn, ...rangesEn, ...bettingEn, ...preflopEn };
const hr: ConceptTexts = { ...foundationsHr, ...rangesHr, ...bettingHr, ...preflopHr };

export const CONCEPT_TEXT: Readonly<Record<Locale, ConceptTexts>> = { en, hr };

export function conceptText(locale: Locale, id: ConceptId): ConceptText {
  return CONCEPT_TEXT[locale][id];
}

export type { ConceptExample, ConceptText, ConceptTexts, Formula, FormulaNode } from "./types";
