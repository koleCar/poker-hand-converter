/**
 * The checker's numbers in words (docs/ANALYTICS.md Step 3): a stat's gap
 * ("Folds too much · +11 pts"), a breakdown row's name, and an Overview
 * finding's headline and why-sentence. The numbers come from `checkStats`
 * (`model/checker.ts`); the words from `strings/analytics.{en,hr}.ts` and the
 * catalogue's labels, in the strings' `lang`. Presentation only: it formats,
 * it does not compute.
 *
 * - **Headline**: the lead stat's own (`findings.headlineByStat`, the weak
 *   shares), else the family's for the lean (`findings.headline`), else
 *   "<stat>: <its words>".
 * - **Why**: the family's template for the lean (`findings.why`), fed the
 *   hand class with the most extra or missing actions (with "a call is
 *   worth"), and the costliest spot.
 */

import type { AnalyticsStrings } from "../i18n";
import type {
  Catalogue,
  CatalogueStat,
  CheckerAxis,
  CheckerDirection,
  CheckerFigures,
  CheckerFinding,
} from "../model/checker";
import { fixedIn } from "../stats/format";
import type { AnalyticsWhyWords } from "../strings/analytics.en";
import { spotName } from "./spot";

/** A percentage in the reader's locale, whole: "62%" / "62 %". */
export function percentText(value: number, words: AnalyticsStrings, locale: string): string {
  return words.checker.percent(fixedIn(locale, 0)(value));
}

/** A gap in points, signed, one decimal under 10: "+3.4 pts", "-11 pts". */
export function pointsText(gap: number, words: AnalyticsStrings, locale: string): string {
  const size = Math.abs(gap);
  const text = fixedIn(locale, size < 10 ? 1 : 0)(size);
  return words.checker.points(gap > 0 ? `+${text}` : gap < 0 ? `-${text}` : text);
}

/** "Flop · Fold vs bet". */
export function statName(stat: CatalogueStat, words: AnalyticsStrings): string {
  const street = words.checker.streets[stat.street];
  const label = stat.label[words.lang];
  return street && stat.street !== "showdown" ? `${street} · ${label}` : label;
}

/** The stat's words for a direction: "Folds too much". */
export function directionWords(stat: CatalogueStat, direction: CheckerDirection, words: AnalyticsStrings): string {
  return stat.words[direction][words.lang];
}

/**
 * A judged stat or row in words: "Folds too much · +11 pts" off target,
 * "In range", "Not sure yet" (a small sample), "No target" (a coded stat),
 * "No target yet" (decisions seen, none analysed against a reference).
 */
export function gapText(
  stat: CatalogueStat,
  figures: Pick<CheckerFigures, "tone" | "gap" | "direction"> & Partial<Pick<CheckerFigures, "n" | "opps">>,
  words: AnalyticsStrings,
  locale: string,
): string {
  switch (figures.tone) {
    case "ok":
      return words.checker.inRange;
    case "few":
      return words.checker.notSure;
    case "none":
      return figures.n === 0 && (figures.opps ?? 0) > 0 && stat.kind !== "coded" ? words.checker.noTargetYet : words.checker.noTarget;
    default:
      if (figures.gap === null || figures.direction === null) return words.checker.noTarget;
      return words.checker.gap(
        directionWords(stat, figures.direction, words),
        pointsText(figures.gap, words, locale),
      );
  }
}

/** A breakdown row's name: the spot (`spotName`), the size bucket's or the hand class's label. */
export function breakdownName(catalogue: Catalogue, axis: CheckerAxis, key: string, words: AnalyticsStrings): string {
  if (axis === "spot") return spotName(key, words.spot);
  const list = axis === "size" ? catalogue.file.sizeBuckets : catalogue.file.handClasses;
  return list.find((item) => item.id === key)?.label[words.lang] ?? key;
}

/** The action class a stat's sentences talk about (a share: its parent's). */
function actionOf(catalogue: Catalogue, stat: CatalogueStat): string | null {
  if (stat.kind === "rate") return stat.class;
  if (stat.kind === "share") {
    const parent = catalogue.get(stat.of);
    return parent?.kind === "rate" ? parent.class : null;
  }
  return null;
}

/** A finding's headline. */
export function findingHeadline(catalogue: Catalogue, finding: CheckerFinding, words: AnalyticsStrings): string {
  const own = words.findings.headlineByStat[finding.lead]?.[finding.lean];
  if (own) return own;
  const family = words.findings.headline[finding.family]?.[finding.lean];
  if (family) return family;
  const stat = catalogue.get(finding.lead);
  if (!stat) return finding.lead;
  return words.findings.fallbackHeadline(statName(stat, words), directionWords(stat, finding.direction, words));
}

/** A finding's why-sentence, from the numbers the checker picked. */
export function findingWhy(
  catalogue: Catalogue,
  finding: CheckerFinding,
  words: AnalyticsStrings,
  locale: string,
): string {
  const why = finding.why;
  const stat = catalogue.get(why.stat);
  const action = stat ? actionOf(catalogue, stat) : null;
  const verbs = (action && words.findings.verbs[action]) || { verb: "", noun: "" };
  const pct = (value: number | null) => (value === null ? "" : percentText(value, words, locale));
  const w: AnalyticsWhyWords = {
    verb: verbs.verb,
    noun: verbs.noun,
    cls: why.handClass === null ? null : breakdownName(catalogue, "class", why.handClass, words),
    classPlayer: pct(why.classPlayer),
    classTarget: pct(why.classTarget),
    worth: why.classWorth === null || why.classWorth <= 0 ? null : fixedIn(locale, 2)(why.classWorth),
    spot: why.spot === null ? null : spotName(why.spot, words.spot),
    spotPlayer: pct(why.spotPlayer),
    spotTarget: pct(why.spotTarget),
    ref: words.findings.ref[why.source] ?? "",
    refOf: words.findings.refOf[why.source] ?? "",
    share: stat?.kind === "share",
  };
  const template = words.findings.why[finding.family]?.[finding.lean] ?? words.findings.fallbackWhy;
  return template(w);
}
