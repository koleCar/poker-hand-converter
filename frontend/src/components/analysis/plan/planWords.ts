/**
 * The words of a plan, in the reader's language: an area named the way Leaks
 * names its leaks, a task as a sentence, its link and the detail beside it.
 * Shared by the plan screen and the overview's card.
 */

"use client";

import { useCallback } from "react";
import { leakKind } from "../../../lib/analysis/leaks";
import type { StoredTask } from "../../../lib/db/studyPlan";
import { useDict } from "../../../lib/i18n/client";
import { parseTrainerRef, type FocusArea, type TrainerTarget } from "../../../lib/training/plan";
import { dateFormat, useIntlLocale } from "../../stats/format";

export function usePlanWords() {
  const en = useDict();
  const locale = useIntlLocale();
  const leaks = en.analysis.leaks;
  const t = en.analysis.plan;
  const settings = en.analysis.train.settings;
  const titles: Readonly<Record<string, string>> = en.learn.titles;

  /** "Checking instead of betting" for the costliest leak, and where. */
  const area = useCallback(
    (focus: FocusArea) => {
      const where = focus.where;
      const top = focus.leaks[0];
      const title = top ? leaks.title(leakKind(top.taken, top.best), where) : leaks.fullContext(where, focus.level, focus.partial);
      const context = leaks.fullContext(where, focus.level, focus.partial);
      const street = leaks.streets[where.street] ?? where.street;
      return { title, context, street, heading: `${street} · ${context}`, name: leaks.name(title, context, where.street) };
    },
    [leaks],
  );

  const trainerWhat = useCallback(
    (target: TrainerTarget) =>
      target.mode === "preflop"
        ? t.tasks.trainPreflop(settings.families[target.family] ?? target.family, target.seat, target.vs)
        : t.tasks.trainRiver(
            target.role === "any" ? null : target.role,
            target.side === "any" ? null : target.side,
            target.pot === "any" ? null : target.pot,
          ),
    [t, settings],
  );

  const date = useCallback(
    (iso: string | null) => (iso ? dateFormat(locale, { day: "numeric", month: "short", year: "numeric" }).format(new Date(iso)) : null),
    [locale],
  );

  /** A task's sentence. `areas` resolves a trainer task's target and a review's hand. */
  const task = useCallback(
    (item: StoredTask, areas: readonly FocusArea[]) => {
      const focus = item.focus !== null ? (areas[item.focus] ?? null) : null;
      switch (item.kind) {
        case "read":
          return `${t.tasks.read}: ${titles[item.ref] ?? item.ref}`;
        case "train": {
          const target = focus?.trainer ?? parseTrainerRef(item.ref);
          return t.tasks.train(item.target, target ? trainerWhat(target) : item.ref);
        }
        case "drill":
          return item.focus === null ? t.tasks.drillAll(item.target) : t.tasks.drill(item.target);
        default: {
          const hand = focus?.reviews.find((review) => review.handId === item.handId) ?? null;
          const detail = hand
            ? t.tasks.reviewDetail(hand.cards.join(" ") || hand.handClass || "", hand.position, hand.evLossBb, date(hand.playedAt))
            : t.tasks.reviewUnknown;
          return `${t.tasks.review}: ${detail}`;
        }
      }
    },
    [t, titles, trainerWhat, date],
  );

  return { area, task, trainerWhat, date };
}
