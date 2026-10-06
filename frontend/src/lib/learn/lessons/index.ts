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
 *   and a "coming soon" page);
 * - `m<n>.*`: the bodies of the written lessons (`LessonMeta.written`).
 */

import type { Locale } from "../../i18n/types";
import type { LessonId } from "../course";
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
import type { LessonBody, LessonOutline, LessonOutlines } from "./types";

type Bodies = Partial<Record<LessonId, LessonBody>>;

const en: Bodies = { ...m0En, ...m1En, ...m2En, ...m3En, ...m6En };
const hr: Bodies = { ...m0Hr, ...m1Hr, ...m2Hr, ...m3Hr, ...m6Hr };

export const LESSON_BODIES: Readonly<Record<Locale, Bodies>> = { en, hr };
export const LESSON_OUTLINES: Readonly<Record<Locale, LessonOutlines>> = { en: outlineEn, hr: outlineHr };

export function lessonOutline(locale: Locale, id: LessonId): LessonOutline {
  return LESSON_OUTLINES[locale][id];
}

/** A written lesson's body in the reader's language; null for a lesson that is not written yet. */
export function lessonBody(locale: Locale, id: LessonId): LessonBody | null {
  return LESSON_BODIES[locale][id] ?? null;
}

export type { Checkpoint, LessonBlock, LessonBody, LessonOutline, LessonSection, MathCheck } from "./types";
