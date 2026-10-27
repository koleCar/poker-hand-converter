/**
 * Which lessons a learner's own play asks for (Learn L1, smart feature 1).
 *
 * The leak finder (A6) and the study plan's focus areas (A8b) name situations
 * by street, scenario, family and seats; a lesson names the spots it teaches
 * in the same words (`LessonMeta.match`, `SpotPattern`). A focus area that
 * costs the learner EV recommends the lesson that matches it most closely,
 * and a heuristic flag that keeps coming up recommends the lessons that
 * explain it. The map shows the badge ("you lose X bb / 100 here"), and the
 * study plan adds the lesson as a task.
 *
 * Pure: the screens fetch the leak rows and the flag counts.
 */

import { ANY, NONE, scenarioFamily, spotAttrs, type SpotAttrs, type SpotRow } from "../analysis/leaks";
import type { FlagCode } from "../analysis/types";
import type { AreaWhere, FocusArea } from "../training/plan";
import { courseOrder, type LessonId, type LessonMeta, type SpotPattern } from "./course";

/** `*` matches any run of characters (`pfr-*-first`, `*-vs-bet`); everything else is literal. */
export function globMatch(pattern: string, value: string): boolean {
  if (!pattern.includes("*")) return pattern === value;
  const parts = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join(".*")}$`).test(value);
}

/** The family a scenario pattern belongs to (`first`, `vs-bet`, …), or null when the pattern leaves it open. */
function patternFamily(street: string, pattern: string): string | null {
  if (street === "preflop") return pattern.includes("*") ? null : scenarioFamily(street, pattern);
  const facing = /-(first|vs-bet|vs-raise)$/.exec(pattern);
  return facing ? facing[1] : null;
}

/** What a situation looks like to the matcher: the leak finder's attributes, parts possibly merged away (`ANY`). */
export type SituationAttrs = Pick<SpotAttrs, "street" | "scenario" | "family" | "hero"> & { best?: string };

const known = (part: string | undefined) => part !== undefined && part !== ANY && part !== NONE && part !== "";

/**
 * How well a pattern fits a situation: 0 for not at all, more for a closer
 * fit (an exact scenario beats a merged one; a named seat or best action that
 * fits adds to it).
 */
export function patternScore(pattern: SpotPattern, attrs: SituationAttrs): number {
  if (pattern.street !== attrs.street) return 0;
  let score = 1;
  if (pattern.scenarios && pattern.scenarios.length > 0) {
    if (known(attrs.scenario)) {
      if (!pattern.scenarios.some((p) => globMatch(p, attrs.scenario))) return 0;
      score += 2;
    } else if (known(attrs.family)) {
      // Merged up to the family: the pattern fits if one of its scenarios is of that family.
      if (!pattern.scenarios.some((p) => patternFamily(pattern.street, p) === attrs.family)) return 0;
      score += 1;
    }
  }
  if (pattern.heroes && pattern.heroes.length > 0 && known(attrs.hero)) {
    if (!pattern.heroes.includes(attrs.hero)) return 0;
    score += 1;
  }
  if (pattern.best && pattern.best.length > 0 && known(attrs.best)) {
    // The reference's best move says what the leak is about (a missed 3-bet,
    // a missed value bet): it outweighs a seat.
    if (!pattern.best.includes(attrs.best as string)) return 0;
    score += 2;
  }
  return score;
}

/** A lesson's best fit to a situation (0: none). */
export function lessonScore(meta: LessonMeta, attrs: SituationAttrs): number {
  let best = 0;
  for (const pattern of meta.match.spots) best = Math.max(best, patternScore(pattern, attrs));
  return best;
}

/** Whether a leak finder row is one of an own-hands exercise's spots. */
export function rowMatches(patterns: readonly SpotPattern[], row: SpotRow): boolean {
  const attrs = spotAttrs(row);
  return patterns.some((pattern) => patternScore(pattern, { ...attrs, best: row.best }) > 0);
}

function areaAttrs(where: AreaWhere, best: string | undefined): SituationAttrs {
  return { street: where.street, scenario: where.scenario, family: where.family, hero: where.hero, best };
}

export interface Recommendation {
  lesson: LessonId;
  /** Why: a focus area that costs EV, or a flag that keeps coming up. */
  reason: "leak" | "flag";
  /** The area's id, for a leak. */
  area?: string;
  evLossBb?: number;
  /** EV lost on the area per 100 graded hands. */
  per100?: number;
  flag?: FlagCode;
  /** Decisions carrying the flag. */
  count?: number;
}

export interface RecommendOptions {
  /** Lessons already passed: never recommended again. */
  passed?: ReadonlySet<LessonId>;
  /** Only lessons that are written (the study plan's tasks); the map also badges "coming soon" ones. */
  writtenOnly?: boolean;
}

/**
 * The lesson for one focus area: the closest fit, a written lesson before a
 * coming-soon one, an earlier lesson before a later one on a tie. Null when
 * no lesson matches.
 */
export function lessonForArea(area: Pick<FocusArea, "where" | "leaks">, options: RecommendOptions = {}): LessonId | null {
  let best: { id: LessonId; score: number; written: boolean; order: number } | null = null;
  courseOrder().forEach((meta, order) => {
    if (options.passed?.has(meta.id)) return;
    if (options.writtenOnly && !meta.written) return;
    let score = 0;
    for (const leak of area.leaks.length > 0 ? area.leaks : [{ best: undefined }]) {
      score = Math.max(score, lessonScore(meta, areaAttrs(area.where, leak.best)));
    }
    if (score === 0) return;
    const better =
      !best ||
      (meta.written && !best.written) ||
      (meta.written === best.written && (score > best.score || (score === best.score && order < best.order)));
    if (better) best = { id: meta.id, score, written: meta.written, order };
  });
  return best ? (best as { id: LessonId }).id : null;
}

/**
 * Recommendations for the course map: one per lesson, from the costliest
 * areas first, then from flags seen at least `minFlags` times. A lesson keeps
 * its first (costliest) reason.
 */
export function recommend(
  areas: readonly Pick<FocusArea, "id" | "where" | "leaks" | "evLossBb" | "per100">[],
  flags: ReadonlyArray<{ code: FlagCode; decisions: number }>,
  options: RecommendOptions & { minFlags?: number; maxAreas?: number } = {},
): Recommendation[] {
  const out = new Map<LessonId, Recommendation>();
  for (const area of areas.slice(0, options.maxAreas ?? 5)) {
    const lesson = lessonForArea(area, options);
    if (!lesson || out.has(lesson)) continue;
    out.set(lesson, { lesson, reason: "leak", area: area.id, evLossBb: area.evLossBb, per100: area.per100 });
  }
  const minFlags = options.minFlags ?? 3;
  for (const { code, decisions } of [...flags].sort((a, b) => b.decisions - a.decisions)) {
    if (decisions < minFlags) continue;
    for (const meta of courseOrder()) {
      if (!meta.match.flags.includes(code) || out.has(meta.id)) continue;
      if (options.passed?.has(meta.id) || (options.writtenOnly && !meta.written)) continue;
      out.set(meta.id, { lesson: meta.id, reason: "flag", flag: code, count: decisions });
      break;
    }
  }
  return [...out.values()];
}

/** The lessons a flag points to, in course order. */
export function lessonsForFlag(code: FlagCode): LessonId[] {
  return courseOrder()
    .filter((meta) => meta.match.flags.includes(code))
    .map((meta) => meta.id);
}
