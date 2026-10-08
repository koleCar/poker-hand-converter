/**
 * "Your hands": a lesson's last exercise (Learn L1, smart feature 2).
 *
 * The learner's own analysed decisions that match the lesson — by spot
 * (the leak finder's rows, `rowMatches`), by heuristic flag, or both — the
 * costliest first, replayed spoiler-safe the way drills are: the hand up to
 * the decision (`handUpTo`, nothing after it, nobody else's cards), the
 * options stored with the grade, the answer graded against them
 * (`gradeDrill`, the analysis' caps), then the verdict and the move really
 * made. A flagged decision without a grade (a heuristic note) is offered to
 * open and look at again.
 *
 * Never required to pass a lesson: a signed-out reader, or one without hands,
 * still passes. The result is recorded like any exercise's.
 */

"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DecisionAnalysis } from "../../../lib/analysis/types";
import { FLOP_DRILLS_AVAILABLE } from "../../../lib/trainer";
import { useAuth } from "../../../lib/auth";
import { fetchAnalysisHands, fetchHandAnalysis, getHand } from "../../../lib/db";
import { fetchLeakHands, fetchLeaks } from "../../../lib/db/analysisLeaks";
import { useDict } from "../../../lib/i18n/client";
import type { LessonMeta, OwnHandsDef } from "../../../lib/learn/course";
import { exerciseResult } from "../../../lib/learn/progress";
import { rowMatches } from "../../../lib/learn/recommend";
import type { PhfHand } from "../../../lib/phf/types";
import { paths } from "../../../lib/routes";
import { asAnswered, gradeDrill, handUpTo } from "../../../lib/training";
import { focusAreas, pickFocus } from "../../../lib/training/plan";
import { CardRow } from "../../replayer/PlayingCard";
import { ReplayViewer } from "../../replayer/ReplayViewer";
import { AnswerBar, type AnswerOption } from "../../analysis/train/AnswerBar";
import { AnswerResult, useOptionLabel } from "../../analysis/train/AnswerResult";
import { lastAction } from "../../analysis/train/spotPosition";
import own from "../../analysis/train/train.module.css";
import { useLearn } from "./LearnStore";
import styles from "./course.module.css";

interface Candidate {
  handId: string;
  actionIndex: number;
}

type Found = { status: "loading" } | { status: "ready"; items: Candidate[] } | { status: "error"; message: string };

/** The decisions an own-hands exercise offers, costliest first, at most `def.count`. */
async function findCandidates(def: OwnHandsDef): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const add = (handId: string, actionIndex: number) => {
    const key = `${handId}:${actionIndex}`;
    if (seen.has(key) || out.length >= def.count) return;
    seen.add(key);
    out.push({ handId, actionIndex });
  };
  const filters = def.potType ? { potType: def.potType } : {};
  const bySpots = def.spots !== undefined || !def.flags || def.flags.length === 0;
  if (bySpots) {
    const report = await fetchLeaks(filters);
    const rows = report?.rows ?? [];
    let keys: string[];
    if (def.spots && def.spots.length > 0) {
      keys = rows.filter((row) => rowMatches(def.spots ?? [], row)).map((row) => row.key);
    } else if (def.spots) {
      // An empty spot list: the learner's own costliest focus area.
      const top = pickFocus(focusAreas(rows, report?.hands ?? 0), 1)[0];
      keys = top ? top.keys : [];
    } else {
      keys = rows.map((row) => row.key);
    }
    keys = [...new Set(keys)].slice(0, 500);
    if (keys.length > 0) {
      const page = await fetchLeakHands(filters, { keys, deviations: true, sort: "ev_loss", limit: def.count });
      for (const row of page.rows) add(row.handId, row.actionIndex);
    }
  }
  for (const flag of def.flags ?? []) {
    if (out.length >= def.count) break;
    const page = await fetchAnalysisHands({ ...filters, flag }, "ev_loss", def.count, 0);
    for (const hand of page.rows) {
      const analysis = await fetchHandAnalysis(hand.handId);
      const decision = analysis?.decisions.find((d) => d.flags.some((f) => f.code === flag));
      if (decision) add(hand.handId, decision.actionIndex);
    }
  }
  return out;
}

export function OwnHandsExercise({ meta, def }: { meta: LessonMeta; def: OwnHandsDef }) {
  const c = useDict().course;
  const t = c.ownHands;
  const auth = useAuth();
  const store = useLearn();
  const [found, setFound] = useState<Found | null>(null);
  const [at, setAt] = useState(0);
  const [score, setScore] = useState<{ correct: number; total: number }>({ correct: 0, total: 0 });
  const defKey = JSON.stringify(def);

  const start = () => {
    setFound({ status: "loading" });
    setAt(0);
    setScore({ correct: 0, total: 0 });
    findCandidates(JSON.parse(defKey) as OwnHandsDef)
      .then((items) => setFound({ status: "ready", items }))
      .catch((error: unknown) => setFound({ status: "error", message: error instanceof Error ? error.message : String(error) }));
  };

  const onAnswered = useCallback((correct: boolean | null) => {
    if (correct === null) return;
    setScore((prev) => ({ correct: prev.correct + (correct ? 1 : 0), total: prev.total + 1 }));
  }, []);

  if (store.mode !== "account") {
    return (
      <div className={styles.planned}>
        <p>{t.signIn}</p>
        {auth.configured ? (
          <button type="button" className="btn btn--sm" onClick={() => auth.requestSignIn()}>
            {c.map.signIn}
          </button>
        ) : null}
      </div>
    );
  }
  if (!found) {
    return (
      <>
        <p className={styles.muted}>{t.intro}</p>
        <button type="button" className="btn btn--primary" onClick={start}>
          {c.exercise.start}
        </button>
      </>
    );
  }
  if (found.status === "loading") return <p className={styles.muted} role="status">{t.loading}</p>;
  if (found.status === "error") return <p className="notice notice--error">{found.message}</p>;
  if (found.items.length === 0) return <p className={styles.muted}>{t.none}</p>;

  const item = found.items[at] ?? null;
  if (!item) {
    return (
      <Finished
        count={found.items.length}
        onRecord={() =>
          store.record(exerciseResult(store.progress, meta, def.id, score.correct, score.total, score.total > 0, FLOP_DRILLS_AVAILABLE)).catch(() => undefined)
        }
        onRestart={start}
      />
    );
  }
  return (
    <div className={styles.session}>
      <p className={styles.muted}>
        {at + 1} / {found.items.length}
      </p>
      {def.potType || (def.spots && def.spots.some((s) => s.street !== "preflop")) ? <p className={styles.muted}>{t.approximate}</p> : null}
      <OwnHand key={`${item.handId}:${item.actionIndex}`} candidate={item} onAnswered={onAnswered} onNext={() => setAt((value) => value + 1)} />
    </div>
  );
}

function Finished({ count, onRecord, onRestart }: { count: number; onRecord: () => void; onRestart: () => void }) {
  const t = useDict().course;
  const recorded = useRef(false);
  useEffect(() => {
    if (recorded.current) return;
    recorded.current = true;
    onRecord();
  }, [onRecord]);
  return (
    <div className={styles.result}>
      <p>{t.ownHands.done(count)}</p>
      <button type="button" className="btn btn--sm" onClick={onRestart}>
        {t.exercise.restart}
      </button>
    </div>
  );
}

type Loaded =
  | { status: "loading" }
  | { status: "ready"; phf: PhfHand; decision: DecisionAnalysis }
  | { status: "review"; decision: DecisionAnalysis | null }
  | { status: "error"; message: string };

function OwnHand({ candidate, onAnswered, onNext }: { candidate: Candidate; onAnswered: (correct: boolean | null) => void; onNext: () => void }) {
  const en = useDict();
  const t = en.course.ownHands;
  const label = useOptionLabel();
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [answer, setAnswer] = useState<{ picked: number; shown: DecisionAnalysis } | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([getHand(candidate.handId), fetchHandAnalysis(candidate.handId)])
      .then(([record, analysis]) => {
        if (!live) return;
        const decision = analysis?.decisions.find((d) => d.actionIndex === candidate.actionIndex) ?? null;
        if (!record || !decision || decision.grade === null || decision.chosen === null || decision.options.length === 0) {
          setLoaded({ status: "review", decision });
          return;
        }
        setLoaded({ status: "ready", phf: record.phf, decision });
      })
      .catch((error: unknown) => {
        if (live) setLoaded({ status: "error", message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      live = false;
    };
  }, [candidate]);

  const spot = loaded.status === "ready" ? loaded : null;
  const options = useMemo<AnswerOption[]>(
    () =>
      spot
        ? spot.decision.options.map((option) => ({
            label: label(option),
            alias: option.allIn ? "allin" : option.action === "fold" || option.action === "check" || option.action === "call" ? option.action : null,
          }))
        : [],
    [spot, label],
  );
  const shownHand = useMemo(() => (spot ? handUpTo(spot.phf, spot.decision.actionIndex) : null), [spot]);

  const pick = (index: number) => {
    if (!spot || answer) return;
    const d = spot.decision;
    const result = gradeDrill(
      {
        options: d.options,
        chosen: d.chosen ?? 0,
        grade: d.grade ?? "mistake",
        evLoss: d.evLoss ?? 0,
        evLossPot: d.evLossPot ?? 0,
        freqDiff: d.freqDiff ?? 0,
        score: d.score ?? 0,
        potBb: d.facts.potBb,
        source: d.source,
        approximations: d.approximations,
      },
      index,
    );
    setAnswer({ picked: index, shown: asAnswered(d, index, result) });
    onAnswered(result.grade === "perfect" || result.grade === "good");
  };

  const openLink = (
    <Link href={paths.analysisHand(candidate.handId, `t=a${candidate.actionIndex}`)}>{t.open}</Link>
  );

  if (loaded.status === "loading") return <p className={styles.muted} role="status">{t.loading}</p>;
  if (loaded.status === "error") return <p className="notice notice--error">{loaded.message}</p>;
  if (loaded.status === "review") {
    return (
      <div className={styles.item}>
        <p>
          {t.reviewOnly} {openLink}
        </p>
        <div className={styles.nextRow}>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => {
              onAnswered(null);
              onNext();
            }}
          >
            {en.course.exercise.next}
          </button>
        </div>
      </div>
    );
  }
  if (!spot || !shownHand) return null;
  return (
    <div className={styles.item}>
      <div className={own.prompt}>
        <div className={own.hero}>
          <span className={own.heroLabel}>{en.analysis.train.yourHand}</span>
          <CardRow cards={spot.decision.facts.holeCards} size="md" />
        </div>
        <div className={own.promptText}>
          <p>
            {en.analysis.streets[spot.decision.street]} · {en.analysis.sheet.spotValue(spot.decision.facts)}
          </p>
          <p className={own.question}>{t.question}</p>
        </div>
      </div>
      <div className={own.table}>
        <ReplayViewer hand={shownHand} mode="embed" urlSync={false} initialPosition={lastAction(shownHand)} />
      </div>
      <AnswerBar options={options} picked={answer?.picked ?? null} disabled={Boolean(answer)} onPick={pick} />
      {answer ? (
        <>
          <AnswerResult decision={answer.shown} hand={spot.phf}>
            <p className={own.muted}>
              {t.youPlayed(
                spot.decision.chosen !== null ? label(spot.decision.options[spot.decision.chosen]) : "—",
                spot.decision.grade ? (en.analysis.grades[spot.decision.grade] ?? spot.decision.grade) : "—",
              )}{" "}
              {openLink}
            </p>
          </AnswerResult>
          <div className={styles.nextRow}>
            <button type="button" className="btn btn--primary" onClick={onNext}>
              {en.course.exercise.next}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
