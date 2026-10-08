/**
 * The lessons' words, by locale (Learn L1).
 *
 * **Server-only by use, not by import**, like the concept pages' texts
 * (`../content/index.ts`): only the server components under `app/learn/` read
 * them, and they pass a lesson's checkpoints and exercise lines to its client
 * islands as props, so a page ships only its own lesson. Nothing here imports
 * `server-only`, so `tests/test/` can check the structure and the numbers
 * under plain Node.
 *
 * - `outline.*`: every lesson's summary and goals, written or not (the map,
 *   and a "coming soon" page), and every reference page's;
 * - `m3.*` (preflop), `f1.*`–`f5.*` and `m6.*` (the flop track, L2), `t.*`
 *   and `r.*` (the turn and river tracks, L3): the bodies of the written
 *   lessons (`LessonMeta.written`);
 * - `m0.*`, `m1.*`, `m2.*`: the reference pages' bodies (L1's orientation,
 *   maths and range lessons, out of the map since L1.1; `REFERENCE_IDS`).
 */

import type { Locale } from "../../i18n/types";
import type { LessonId, ReferenceId } from "../course";
import { f1En } from "./f1.en";
import { f1Hr } from "./f1.hr";
import { f2En } from "./f2.en";
import { f2Hr } from "./f2.hr";
import { f3En } from "./f3.en";
import { f3Hr } from "./f3.hr";
import { f4En } from "./f4.en";
import { f4Hr } from "./f4.hr";
import { f5En } from "./f5.en";
import { f5Hr } from "./f5.hr";
import { m0En } from "./m0.en";
import { m0Hr } from "./m0.hr";
import { m1En } from "./m1.en";
import { m1Hr } from "./m1.hr";
import { m2En } from "./m2.en";
import { m2Hr } from "./m2.hr";
import { m3En } from "./m3.en";
import { m3Hr } from "./m3.hr";
import { m6En } from "./m6.en";
import { m6Hr } from "./m6.hr";
import { outlineEn } from "./outline.en";
import { outlineHr } from "./outline.hr";
import { rEn } from "./r.en";
import { rHr } from "./r.hr";
import { tEn } from "./t.en";
import { tHr } from "./t.hr";
import type { LessonBody, LessonOutline, LessonOutlines, PageId } from "./types";

type Bodies = Partial<Record<LessonId, LessonBody>>;
type ReferenceBodies = Readonly<Record<ReferenceId, LessonBody>>;

const en: Bodies = { ...m3En, ...f1En, ...f2En, ...f3En, ...f4En, ...m6En, ...f5En, ...tEn, ...rEn };
const hr: Bodies = { ...m3Hr, ...f1Hr, ...f2Hr, ...f3Hr, ...f4Hr, ...m6Hr, ...f5Hr, ...tHr, ...rHr };

export const LESSON_BODIES: Readonly<Record<Locale, Bodies>> = { en, hr };
export const REFERENCE_BODIES: Readonly<Record<Locale, ReferenceBodies>> = {
  en: { ...m0En, ...m1En, ...m2En },
  hr: { ...m0Hr, ...m1Hr, ...m2Hr },
};
export const LESSON_OUTLINES: Readonly<Record<Locale, LessonOutlines>> = { en: outlineEn, hr: outlineHr };

export function lessonOutline(locale: Locale, id: PageId): LessonOutline {
  return LESSON_OUTLINES[locale][id];
}

/** A reference page's body in the reader's language. */
export function referenceBody(locale: Locale, id: ReferenceId): LessonBody {
  return REFERENCE_BODIES[locale][id];
}

/** A written lesson's body in the reader's language; null for a lesson that is not written yet. */
export function lessonBody(locale: Locale, id: LessonId): LessonBody | null {
  return LESSON_BODIES[locale][id] ?? null;
}

export type { Checkpoint, LessonBlock, LessonBody, LessonOutline, LessonSection, MathCheck, PageId } from "./types";
export { plainText, refLinks } from "./types";
