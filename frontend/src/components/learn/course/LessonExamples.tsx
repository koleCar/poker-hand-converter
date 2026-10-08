/**
 * A lesson's example hands (Learn L5, the `examples` slot of `course.ts`).
 * Two sources only, never a hand from outside Rail:
 *
 * - **your own hands** (`own`): among the learner's graded decisions in the
 *   lesson's spots (the leak finder's rows, `rowMatches`) — or, when none,
 *   its flags — the costliest mistake and a clean Perfect
 *   (`lib/learn/examples.ts`). Spoiler-safe: the spot and the hand show
 *   first; the verdict and Rail's "why" only on request; the link replays
 *   the hand up to the decision.
 * - **a hand Rail deals** (`scripted`): one of the lesson's own trainer
 *   exercises from a fixed seed, written out as hand text and graded by the
 *   analysis (`CardItemView`, as the lesson deals it), not recorded.
 */

"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { fetchAnalysisHands, fetchHandAnalysis } from "../../../lib/db";
import { fetchLeakHands, fetchLeaks } from "../../../lib/db/analysisLeaks";
import { useDict } from "../../../lib/i18n/client";
import { exerciseOf, type LessonExample, type LessonMeta } from "../../../lib/learn/course";
import { cleanPerfect, costliest, exampleWhy, type ExampleCandidate } from "../../../lib/learn/examples";
import { cardFor } from "../../../lib/learn/progress";
import { rowMatches } from "../../../lib/learn/recommend";
import { paths } from "../../../lib/routes";
import { CardRow } from "../../replayer/PlayingCard";
import { useOptionLabel } from "../../analysis/train/AnswerResult";
import { useFormats } from "../controls";
import { CardItemView } from "./ExerciseBlock";
import { useLearn } from "./LearnStore";
import styles from "./course.module.css";

type OwnExample = Extract<LessonExample, { kind: "own" }>;
type Found = { status: "loading" } | { status: "ready"; worst: ExampleCandidate | null; perfect: ExampleCandidate | null } | { status: "error"; message: string };

/** Decisions read for the clean Perfect, at most. */
const PERFECT_POOL = 100;

async function findExamples(example: OwnExample): Promise<{ worst: ExampleCandidate | null; perfect: ExampleCandidate | null }> {
  const filters = example.potType ? { potType: example.potType } : {};
  let worst: ExampleCandidate | null = null;
  let perfect: ExampleCandidate | null = null;
  if (example.spots.length > 0) {
    const report = await fetchLeaks(filters);
    const keys = [...new Set((report?.rows ?? []).filter((row) => rowMatches(example.spots, row)).map((row) => row.key))].slice(0, 500);
    if (keys.length > 0) {
      const [mistakes, recent] = await Promise.all([
        fetchLeakHands(filters, { keys, deviations: true, sort: "ev_loss", limit: 10 }),
        fetchLeakHands(filters, { keys, deviations: false, sort: "recent", limit: PERFECT_POOL }),
      ]);
      worst = costliest(mistakes.rows);
      perfect = cleanPerfect(recent.rows);
    }
  }
  // No mistake in the spots: the costliest decision carrying one of the lesson's flags.
  for (const flag of example.flags) {
    if (worst) break;
    const page = await fetchAnalysisHands({ ...filters, flag }, "ev_loss", 1, 0);
    const hand = page.rows[0];
    if (!hand) continue;
    const analysis = await fetchHandAnalysis(hand.handId);
    const d = analysis?.decisions.find((decision) => decision.flags.some((f) => f.code === flag));
    if (!d) continue;
    worst = costliest([
      {
        handId: hand.handId,
        actionIndex: d.actionIndex,
        street: d.street,
        position: null,
        heroCards: d.facts.holeCards,
        grade: d.grade,
        evLossBb: d.evLoss,
        evLossPot: d.evLossPot,
        options: d.options,
        chosen: d.chosen,
      },
    ]);
  }
  return { worst, perfect };
}

export function LessonExamples({ meta }: { meta: LessonMeta }) {
  const t = useDict().course.examples;
  const examples = meta.examples ?? [];
  if (examples.length === 0) return null;
  return (
    <div className={styles.examples}>
      <p className={styles.muted}>{t.intro}</p>
      {examples.map((example) =>
        example.kind === "own" ? <OwnExamples key={example.id} example={example} /> : <ScriptedExample key={example.id} meta={meta} example={example} />,
      )}
    </div>
  );
}

function OwnExamples({ example }: { example: OwnExample }) {
  const c = useDict().course;
  const t = c.examples;
  const store = useLearn();
  const [found, setFound] = useState<Found | null>(null);

  const find = () => {
    setFound({ status: "loading" });
    findExamples(example)
      .then((result) => setFound({ status: "ready", ...result }))
      .catch((error: unknown) => setFound({ status: "error", message: error instanceof Error ? error.message : String(error) }));
  };

  return (
    <section className={styles.exampleCard} aria-label={t.ownTitle}>
      <strong>{t.ownTitle}</strong>
      {store.mode !== "account" ? (
        <p className={styles.muted}>{t.signIn}</p>
      ) : !found ? (
        <div className={styles.panelRow}>
          <button type="button" className="btn btn--sm" onClick={find}>
            {t.find}
          </button>
        </div>
      ) : found.status === "loading" ? (
        <p className={styles.muted} role="status">
          {t.loading}
        </p>
      ) : found.status === "error" ? (
        <p className="notice notice--warn">{t.failed(found.message)}</p>
      ) : !found.worst && !found.perfect ? (
        <p className={styles.muted}>{t.none}</p>
      ) : (
        <>
          {found.worst ? <OwnExample title={t.costliest} row={found.worst} /> : null}
          {found.perfect ? <OwnExample title={t.perfect} row={found.perfect} /> : null}
        </>
      )}
    </section>
  );
}

function OwnExample({ title, row }: { title: string; row: ExampleCandidate }) {
  const en = useDict();
  const t = en.course.examples;
  const f = useFormats();
  const label = useOptionLabel();
  const [shown, setShown] = useState(false);
  const why = useMemo(() => exampleWhy(row), [row]);
  const street = en.analysis.streets[row.street] ?? row.street;

  let text = "";
  if (why?.kind === "mistake") {
    text = t.whyMistake(
      label(why.taken),
      label(why.reference),
      f.bb(why.lossBb),
      why.lossPot !== null ? f.pct(why.lossPot) : null,
      en.analysis.grades[why.grade] ?? why.grade,
    );
  } else if (why?.kind === "perfect") {
    text = t.whyPerfect(label(why.taken), f.pct(why.taken.freq), label(why.next), f.bb(why.marginBb));
  }

  return (
    <div className={styles.item}>
      <p>
        <strong>{title}</strong> · {t.spot(street, row.position)}
      </p>
      {row.heroCards.length > 0 ? <CardRow cards={[...row.heroCards]} size="sm" /> : null}
      <div className={styles.panelRow}>
        <Link href={paths.analysisHand(row.handId, `t=a${row.actionIndex}`)} className="btn btn--sm btn--ghost">
          {t.open}
        </Link>
        {!shown && text ? (
          <button type="button" className="btn btn--sm" onClick={() => setShown(true)}>
            {t.show}
          </button>
        ) : null}
      </div>
      {shown ? <p aria-live="polite">{text}</p> : null}
    </div>
  );
}

function ScriptedExample({ meta, example }: { meta: LessonMeta; example: Extract<LessonExample, { kind: "scripted" }> }) {
  const t = useDict().course.examples;
  const [dealt, setDealt] = useState(false);
  const def = exerciseOf(meta, example.exercise);
  const item = useMemo(() => {
    if (!def || def.kind === "own-hands" || "waitsFor" in def) return null;
    return cardFor(meta, def, example.seed).item;
  }, [meta, def, example.seed]);
  if (!item) return null;
  return (
    <section className={styles.exampleCard} aria-label={t.scriptedTitle}>
      <strong>{t.scriptedTitle}</strong>
      <p className={styles.muted}>{t.scriptedIntro}</p>
      {dealt ? (
        <CardItemView item={item} signedIn={false} onAnswer={() => undefined} />
      ) : (
        <div className={styles.panelRow}>
          <button type="button" className="btn btn--sm" onClick={() => setDealt(true)}>
            {t.deal}
          </button>
        </div>
      )}
    </section>
  );
}
