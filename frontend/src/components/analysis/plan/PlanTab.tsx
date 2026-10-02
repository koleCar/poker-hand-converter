/**
 * The study plan (`/analysis/plan`, `docs/ANALYSIS-PLAN.md` §7, phase A8b):
 * "here is what to work on this week, and how".
 *
 * - **This week.** The plan for the reader's ISO week (named by its local
 *   Monday). The first visit of a week builds it from the leak finder
 *   (`buildPlan.ts`): that is the rollover, and last week's plan stays as it
 *   was. "Rebuild" builds it again from the latest analysis; tasks it keeps
 *   keep their ticks.
 * - **Focus areas**, at most three: why each matters (EV lost, per 100
 *   hands, mistakes in the spot, confidence — a thin one is labelled
 *   tentative), the leaks in it, and its checklist: concepts to read (Learn),
 *   a trainer session set to the spot, the drills due on it, and hands of the
 *   reader's own to review.
 * - **Progress.** The database counts trainer answers and drill reviews
 *   inside the week towards their tasks; concepts and hands are ticked here.
 *   Anything can be ticked by hand.
 * - **Last week.** Its checklist's completion, and A6's comparison for its
 *   focus areas (this week's when there was no plan): the mistake rate in the
 *   spot and EV lost per 100 hands, worded no more confidently than the
 *   sample allows.
 * - Too little graded play: the fundamentals instead (core concepts, the
 *   preflop trainer first in and in the big blind, a few river spots).
 */

"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ANALYSIS_VERSION } from "../../../lib/analysis";
import { comparePeriods, leakKind } from "../../../lib/analysis/leaks";
import { DATABASE_NOT_CONFIGURED_MESSAGE, isDatabaseConfigured, isMissingSchemaError } from "../../../lib/db";
import { fetchLeaks, type LeaksReport } from "../../../lib/db/analysisLeaks";
import { fetchStudyPlan, setStudyTask, type StoredPlan, type StoredTask } from "../../../lib/db/studyPlan";
import { fetchDrillsBySpot } from "../../../lib/db/training";
import { useAuth } from "../../../lib/auth";
import { useDict } from "../../../lib/i18n/client";
import { paths } from "../../../lib/routes";
import {
  MIN_PLAN_MOVES,
  addWeeks,
  areaChange,
  daysLeft,
  parseTrainerRef,
  planProgress,
  retroWindows,
  weekBounds,
  weekStart,
  type FocusArea,
} from "../../../lib/training/plan";
import { AnalysisNav } from "../AnalysisNav";
import { TrendTag } from "../leaks/WhatChanged";
import { EMPTY_LEAKS_STATE, leaksQuery } from "../leaks/leaksState";
import leakStyles from "../leaks/leaks.module.css";
import { dueDrillQuery, targetQuery } from "../train/trainState";
import { buildPlan } from "./buildPlan";
import { usePlanWords } from "./planWords";
import styles from "./plan.module.css";
import "../../../styles/stats.css";

/** The migration the screen needs, named in the not-installed notice. An identifier, not prose. */
const PLAN_MIGRATION = "supabase/migrations/20270215090000_analysis_study_plan.sql";
const CONFIDENCE_GLYPH = { low: "●○○", medium: "●●○", high: "●●●" } as const;
/** Under this many graded moves in the current period the comparison is a hint (A6's card). */
const THIN_PERIOD = 50;

type Status = "ready" | "not-installed" | "error";

interface Loaded {
  key: string;
  status: Status;
  current: StoredPlan | null;
  previous: StoredPlan | null;
  message: string | null;
}

export function PlanTab({ refreshToken = 0 }: { refreshToken?: number }) {
  const en = useDict();
  const t = en.analysis.plan;
  const auth = useAuth();
  // The week is fixed when the page opens: a page left open past midnight on Sunday keeps its week.
  const [now] = useState(() => new Date());
  const week = useMemo(() => weekStart(now), [now]);
  const lastWeek = useMemo(() => addWeeks(week, -1), [week]);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const builtFor = useRef<string | null>(null);
  const signedIn = isDatabaseConfigured && auth.isSignedIn;

  const requestKey = `${week}|${refreshToken}|${attempt}`;
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    Promise.all([fetchStudyPlan(week, weekBounds(week).from), fetchStudyPlan(lastWeek, weekBounds(lastWeek).from)])
      .then(([current, previous]) => {
        if (live) setLoaded({ key: requestKey, status: "ready", current, previous, message: null });
      })
      .catch((error: unknown) => {
        if (!live) return;
        setLoaded({
          key: requestKey,
          status: isMissingSchemaError(error) ? "not-installed" : "error",
          current: null,
          previous: null,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      live = false;
    };
  }, [signedIn, week, lastWeek, requestKey]);

  // The rollover: a week with no plan gets one, built once per page visit. A
  // fundamentals plan made for want of graded hands is rebuilt the same way, so
  // the first analysis of a library turns it into a leaks plan without a wait
  // for Monday (when there is still too little, the rebuild changes nothing).
  const waiting =
    loaded?.current === null ||
    (loaded?.current?.kind === "fundamentals" && loaded.current.baseline.reason !== "no-leaks");
  const needsBuild = loaded?.status === "ready" && waiting && loaded.key === requestKey;
  useEffect(() => {
    if (!needsBuild || !loaded || builtFor.current === week) return;
    builtFor.current = week;
    buildPlan(week, loaded.previous)
      .then(() => setAttempt((value) => value + 1))
      .catch((error: unknown) => setBuildError(error instanceof Error ? error.message : String(error)));
  }, [needsBuild, loaded, week]);

  const rebuild = useCallback(() => {
    setRebuilding(true);
    setBuildError(null);
    buildPlan(week, loaded?.previous ?? null)
      .then(() => setAttempt((value) => value + 1))
      .catch((error: unknown) => setBuildError(error instanceof Error ? error.message : String(error)))
      .finally(() => setRebuilding(false));
  }, [week, loaded]);

  const retry = useCallback(() => {
    builtFor.current = null;
    setBuildError(null);
    setAttempt((value) => value + 1);
  }, []);

  if (!isDatabaseConfigured) {
    return (
      <div className="stats">
        <Header />
        <p className="notice notice--warn">{DATABASE_NOT_CONFIGURED_MESSAGE}</p>
      </div>
    );
  }
  if (!auth.isSignedIn) return <SignedOut />;

  if (loaded?.status === "not-installed") {
    return (
      <div className="stats">
        <Header />
        <div className="card stats-empty">
          <h3>{t.notInstalledHeading}</h3>
          <p className="muted">
            {t.notInstalledBefore}
            <code>{PLAN_MIGRATION}</code>
            {t.notInstalledAfter}
          </p>
        </div>
      </div>
    );
  }
  if (loaded?.status === "error") {
    return (
      <div className="stats">
        <Header />
        <p className="notice notice--error">{t.failed(loaded.message ?? "")}</p>
        <button type="button" className="btn" onClick={retry}>
          {t.tryAgain}
        </button>
      </div>
    );
  }

  const plan = loaded?.current ?? null;
  if (!plan) {
    return (
      <div className="stats">
        <Header />
        <p className={styles.lede}>{t.intro}</p>
        {buildError ? (
          <>
            <p className="notice notice--error">{t.saveFailed(buildError)}</p>
            <button type="button" className="btn" onClick={retry}>
              {t.tryAgain}
            </button>
          </>
        ) : (
          <p className="muted" role="status">
            {loaded ? t.building : t.loading}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="stats">
      <Header />
      <p className={styles.lede}>{t.intro}</p>
      {buildError ? <p className="notice notice--error">{t.saveFailed(buildError)}</p> : null}
      <PlanBody
        plan={plan}
        previous={loaded?.previous ?? null}
        now={now}
        rebuilding={rebuilding}
        onRebuild={rebuild}
        onChanged={() => setAttempt((value) => value + 1)}
        refreshKey={requestKey}
      />
    </div>
  );
}

function Header() {
  const t = useDict().analysis.plan;
  return (
    <>
      <header className="stats__head">
        <h2>{t.heading}</h2>
      </header>
      <AnalysisNav current="plan" />
    </>
  );
}

function SignedOut() {
  const t = useDict().analysis.tab;
  const auth = useAuth();
  return (
    <div className="stats">
      <Header />
      <div className="card stats-empty">
        <h3>{t.signInHeading}</h3>
        <p className="muted">{t.signInBody}</p>
        <button type="button" className="btn btn--primary" onClick={() => auth.requestSignIn()}>
          {t.signIn}
        </button>
      </div>
    </div>
  );
}

/** A tick on its way to the database: shown at once, kept until the plan reloads. */
type Pending = Record<string, boolean>;

function PlanBody({
  plan,
  previous,
  now,
  rebuilding,
  onRebuild,
  onChanged,
  refreshKey,
}: {
  plan: StoredPlan;
  previous: StoredPlan | null;
  now: Date;
  rebuilding: boolean;
  onRebuild: () => void;
  onChanged: () => void;
  refreshKey: string;
}) {
  const t = useDict().analysis.plan;
  const [pending, setPending] = useState<{ key: string; ticks: Pending }>({ key: refreshKey, ticks: {} });
  const [tickError, setTickError] = useState<string | null>(null);
  const [drills, setDrills] = useState<Map<string, { items: number; due: number }> | null>(null);
  const ticks = useMemo<Pending>(() => (pending.key === refreshKey ? pending.ticks : {}), [pending, refreshKey]);

  // Drills due now, per spot: the live count beside each drill task.
  useEffect(() => {
    let live = true;
    fetchDrillsBySpot()
      .then((map) => {
        if (live) setDrills(map);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [refreshKey]);

  const tasks = useMemo(
    () =>
      plan.tasks.map((task) =>
        task.id in ticks
          ? {
              ...task,
              doneAt: ticks[task.id] ? (task.doneAt ?? new Date().toISOString()) : null,
              done: ticks[task.id] || task.counted >= task.target,
              progress: ticks[task.id] ? task.target : Math.min(task.target, task.counted),
            }
          : task,
      ),
    [plan.tasks, ticks],
  );

  const toggle = useCallback(
    (task: StoredTask, done: boolean) => {
      setTickError(null);
      setPending((current) => ({ key: refreshKey, ticks: { ...(current.key === refreshKey ? current.ticks : {}), [task.id]: done } }));
      setStudyTask(task.id, done)
        .then(() => onChanged())
        .catch((error: unknown) => {
          setTickError(error instanceof Error ? error.message : String(error));
          setPending((current) => {
            const next = { ...current.ticks };
            delete next[task.id];
            return { key: current.key, ticks: next };
          });
        });
    },
    [refreshKey, onChanged],
  );

  const progress = planProgress(tasks);
  const bounds = { from: plan.from, to: plan.to };
  const stale = plan.analysisVersion !== ANALYSIS_VERSION;
  const general = tasks.filter((task) => task.focus === null);

  return (
    <>
      <section className={`card ${styles.week}`} aria-labelledby="plan-week">
        <div className={styles.weekHead}>
          <h3 id="plan-week">{t.week(bounds.from, bounds.to)}</h3>
          <span className="muted">{t.daysLeft(daysLeft(plan.weekStart, now))}</span>
        </div>
        <Meter done={progress.done} total={progress.total} share={progress.share} />
        <p className="muted">{t.autoNote}</p>
        {stale ? <p className="notice notice--warn">{t.staleVersion(plan.analysisVersion, ANALYSIS_VERSION)}</p> : null}
        <div className={styles.rebuild}>
          <button type="button" className="btn btn--sm" onClick={onRebuild} disabled={rebuilding} aria-describedby="plan-rebuild-note">
            {rebuilding ? t.rebuilding : t.rebuild}
          </button>
          <span id="plan-rebuild-note" className="muted">
            {t.builtOn(plan.updatedAt || plan.createdAt)} {t.rebuildNote}
          </span>
        </div>
        {tickError ? <p className="notice notice--error">{t.tickFailed(tickError)}</p> : null}
      </section>

      {plan.kind === "fundamentals" ? (
        <Fundamentals plan={plan} tasks={general} drills={drills} onToggle={toggle} />
      ) : (
        <section className="card stats-group" aria-labelledby="plan-focus">
          <h3 id="plan-focus">{t.focusHeading}</h3>
          <p className="muted">{t.focusIntro(plan.focus.length)}</p>
          <ol className={styles.areas}>
            {plan.focus.map((area, index) => (
              <AreaItem
                key={area.id}
                area={area}
                index={index}
                areas={plan.focus}
                tasks={tasks.filter((task) => task.focus === index)}
                drills={drills}
                onToggle={toggle}
              />
            ))}
          </ol>
          {general.length > 0 ? <TaskList tasks={general} areas={plan.focus} drills={drills} onToggle={toggle} /> : null}
        </section>
      )}

      <Retrospective plan={plan} previous={previous} />
    </>
  );
}

function Meter({ done, total, share }: { done: number; total: number; share: number }) {
  const t = useDict().analysis.plan;
  const id = useId();
  return (
    <div className={styles.meter}>
      <span id={id}>{t.progress(done, total)}</span>
      <div
        className={styles.track}
        role="progressbar"
        aria-labelledby={id}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-valuetext={t.progress(done, total)}
      >
        <div className={styles.fill} style={{ inlineSize: `${Math.round(Math.min(1, share) * 100)}%` }} />
      </div>
    </div>
  );
}

function Fundamentals({
  plan,
  tasks,
  drills,
  onToggle,
}: {
  plan: StoredPlan;
  tasks: StoredTask[];
  drills: Map<string, { items: number; due: number }> | null;
  onToggle: (task: StoredTask, done: boolean) => void;
}) {
  const t = useDict().analysis.plan;
  const reason = plan.baseline.reason;
  return (
    <section className="card stats-group" aria-labelledby="plan-basics">
      <h3 id="plan-basics">{t.fundamentals.heading}</h3>
      <p>
        {reason === "few"
          ? t.fundamentals.few(plan.baseline.graded, MIN_PLAN_MOVES)
          : reason === "no-leaks"
            ? t.fundamentals.noLeaks
            : t.fundamentals.none}
      </p>
      {reason === "none" || reason === null ? (
        <p>
          <Link href={paths.analysis()} className="btn btn--sm">
            {t.fundamentals.goToAnalysis}
          </Link>
        </p>
      ) : null}
      <TaskList tasks={tasks} areas={[]} drills={drills} onToggle={onToggle} />
    </section>
  );
}

function AreaItem({
  area,
  index,
  areas,
  tasks,
  drills,
  onToggle,
}: {
  area: FocusArea;
  index: number;
  areas: readonly FocusArea[];
  tasks: StoredTask[];
  drills: Map<string, { items: number; due: number }> | null;
  onToggle: (task: StoredTask, done: boolean) => void;
}) {
  const en = useDict();
  const t = en.analysis.plan;
  const words = usePlanWords();
  const name = words.area(area);
  const headingId = useId();
  const leakHref = paths.analysisLeaks(leaksQuery({ ...EMPTY_LEAKS_STATE, leak: area.leaks[0]?.id ?? null }));
  return (
    <li className={`${styles.area}`} aria-labelledby={headingId}>
      <div className={styles.areaHead}>
        <span className={styles.areaLabel}>{t.area.label(index + 1)}</span>
        <h4 id={headingId}>{name.heading}</h4>
        <div className={styles.tags}>
          <span className={`${leakStyles.confidence} ${leakStyles[area.confidence]}`}>
            <span aria-hidden="true" className={leakStyles.confidenceGlyph}>
              {CONFIDENCE_GLYPH[area.confidence]}
            </span>
            {en.analysis.leaks.confidence[area.confidence]}
          </span>
          {area.tentative ? <span className={styles.tag}>{t.area.tentative}</span> : null}
          {area.weeks > 1 ? <span className={styles.tag}>{t.area.weeks(area.weeks)}</span> : null}
        </div>
      </div>

      <h5 className={styles.subhead}>{t.area.why}</h5>
      <p>{t.area.numbers(area.evLossBb, area.per100, area.mistakes, area.spotDecisions)}</p>
      <ul className={styles.leakLines}>
        {area.leaks.map((leak) => (
          <li key={leak.id}>{t.area.leak(en.analysis.leaks.title(leakKind(leak.taken, leak.best), area.where), leak.evLossBb, leak.mistakes)}</li>
        ))}
      </ul>
      {area.tentative ? <p className="notice notice--warn">{t.area.tentativeNote}</p> : null}
      <p>
        <Link href={leakHref}>{t.area.openLeak}</Link>
      </p>

      <h5 className={styles.subhead}>{t.area.checklist}</h5>
      <TaskList tasks={tasks} areas={areas} drills={drills} onToggle={onToggle} />
    </li>
  );
}

function TaskList({
  tasks,
  areas,
  drills,
  onToggle,
}: {
  tasks: StoredTask[];
  areas: readonly FocusArea[];
  drills: Map<string, { items: number; due: number }> | null;
  onToggle: (task: StoredTask, done: boolean) => void;
}) {
  return (
    <ul className={styles.tasks}>
      {tasks.map((task) => (
        <TaskRow key={task.id} task={task} areas={areas} drills={drills} onToggle={onToggle} />
      ))}
    </ul>
  );
}

function TaskRow({
  task,
  areas,
  drills,
  onToggle,
}: {
  task: StoredTask;
  areas: readonly FocusArea[];
  drills: Map<string, { items: number; due: number }> | null;
  onToggle: (task: StoredTask, done: boolean) => void;
}) {
  const t = useDict().analysis.plan;
  const words = usePlanWords();
  const id = useId();
  const label = words.task(task, areas);
  const area = task.focus !== null ? (areas[task.focus] ?? null) : null;
  // Done by its count (not by a tick): unticking would change nothing, so the box is read-only.
  const counted = task.counted >= task.target && !task.doneAt;

  let href: string;
  let action: string;
  let detail: string | null = null;
  switch (task.kind) {
    case "read":
      href = paths.analysisConcept(task.ref);
      action = t.tasks.openPage;
      break;
    case "train": {
      const target = area?.trainer ?? parseTrainerRef(task.ref);
      href = paths.analysisTrain(target ? targetQuery(target) : undefined);
      action = t.tasks.play;
      detail = t.tasks.counted(task.counted, task.target);
      break;
    }
    case "drill": {
      href = paths.analysisTrain(dueDrillQuery(task.spotKeys));
      action = t.tasks.drillLink;
      let due: number | null = null;
      if (drills) {
        due = 0;
        if (task.spotKeys) for (const key of task.spotKeys) due += drills.get(key)?.due ?? 0;
        else for (const value of drills.values()) due += value.due;
      }
      detail = `${t.tasks.counted(task.counted, task.target)}${due === null ? "" : ` · ${t.tasks.dueNow(due)}`}`;
      break;
    }
    default:
      href = paths.analysisHand(task.handId ?? task.ref);
      action = t.tasks.openHand;
  }

  return (
    <li className={styles.task} data-done={task.done || undefined}>
      <input
        id={id}
        type="checkbox"
        checked={task.done}
        disabled={counted}
        onChange={(event) => onToggle(task, event.target.checked)}
        aria-describedby={detail ? `${id}-detail` : undefined}
      />
      <span className={styles.taskText}>
        <label htmlFor={id}>{label}</label>
        {detail ? (
          <span id={`${id}-detail`} className={styles.taskDetail}>
            {detail}
          </span>
        ) : null}
      </span>
      <Link href={href} className={`btn btn--sm btn--ghost ${styles.taskAction}`} aria-label={t.tasks.linkLabel(action, label)}>
        {action}
      </Link>
    </li>
  );
}

/** The retrospective's data: the two periods' leak rows and which areas they are read for. */
interface Retro {
  key: string;
  windows: ReturnType<typeof retroWindows>;
  current: LeaksReport | null;
  prior: LeaksReport | null;
}

function Retrospective({ plan, previous }: { plan: StoredPlan; previous: StoredPlan | null }) {
  const en = useDict();
  const t = en.analysis.plan;
  const summary = en.analysis.summary;
  const words = usePlanWords();
  const [retro, setRetro] = useState<Retro | null>(null);
  const [error, setError] = useState<string | null>(null);
  const previousWeek = previous?.weekStart ?? null;
  const key = `${plan.id}|${previousWeek ?? ""}`;

  useEffect(() => {
    let live = true;
    (async () => {
      const all = await fetchLeaks({});
      const windows = retroWindows(previousWeek, all?.last ?? null);
      if (!windows) return { key, windows: null, current: null, prior: null };
      const [current, prior] = await Promise.all([
        fetchLeaks({ from: windows.current.from, to: windows.current.to }),
        fetchLeaks({ from: windows.prior.from, to: windows.prior.to }),
      ]);
      return { key, windows, current, prior };
    })()
      .then((value) => {
        if (live) setRetro(value);
      })
      .catch((reason: unknown) => {
        if (live) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      live = false;
    };
  }, [key, previousWeek]);

  // Last week's focus when there was a plan with one; otherwise this week's.
  const fromLastWeek = Boolean(previous && previous.kind === "leaks" && previous.focus.length > 0);
  const areas = fromLastWeek && previous ? previous.focus : plan.focus;
  const lastProgress = previous ? planProgress(previous.tasks) : null;
  const ready = retro?.key === key ? retro : null;

  const comparison = useMemo(
    () =>
      ready?.current && ready.prior
        ? comparePeriods(ready.current.rows, ready.prior.rows, { currentHands: ready.current.hands, priorHands: ready.prior.hands })
        : null,
    [ready],
  );

  return (
    <section className={`card stats-group ${styles.retro}`} aria-labelledby="plan-retro" aria-busy={!ready && !error}>
      <h3 id="plan-retro">{t.retro.heading}</h3>
      {previous && lastProgress ? (
        <p>{t.retro.finished(lastProgress.done, lastProgress.total, previous.from, previous.to)}</p>
      ) : (
        <p className="muted">{t.retro.first}</p>
      )}
      {error ? <p className="notice notice--error">{summary.failed(error)}</p> : null}
      {!ready && !error ? (
        <p className="muted" role="status">
          {summary.loading}
        </p>
      ) : null}
      {ready && !ready.windows ? <p className="muted">{t.retro.nothing}</p> : null}
      {ready?.windows && ready.current && ready.prior && comparison ? (
        <>
          <p>
            {ready.windows.basis === "plan-week"
              ? t.retro.planWeek(ready.windows.current.from, ready.windows.current.to, ready.current.graded, ready.prior.graded)
              : t.retro.lastPlay(
                  ready.windows.current.from,
                  ready.windows.current.to,
                  ready.current.graded,
                  ready.prior.graded,
                  previous !== null,
                )}{" "}
            {ready.windows.basis === "last-play" ? <span className="muted">{t.retro.anchorNote}</span> : null}
          </p>
          {ready.current.graded < THIN_PERIOD ? <p className="notice notice--warn">{summary.thin(ready.current.graded)}</p> : null}
          {comparison.overall.current.mean !== null && comparison.overall.prior.mean !== null ? (
            <p>
              <strong>{summary.overall(comparison.overall.current.mean, comparison.overall.prior.mean)}</strong>{" "}
              <TrendTag trend={comparison.overall.trend} /> <span className="muted">— {summary.trendNotes[comparison.overall.trend]}</span>
            </p>
          ) : null}
          {areas.length > 0 ? (
            <>
              <h4 className={styles.subhead}>{t.retro.areasHeading(fromLastWeek)}</h4>
              <ul className={styles.changes}>
                {areas.map((area) => {
                  const change = areaChange(
                    area,
                    { rows: ready.current!.rows, hands: ready.current!.hands },
                    { rows: ready.prior!.rows, hands: ready.prior!.hands },
                  );
                  const name = words.area(area);
                  return (
                    <li key={area.id}>
                      <strong>{name.heading}</strong>
                      <span>{t.retro.per100(change.current.per100, change.prior.per100)}</span>
                      <span>{summary.rate(change.current.mistakes, change.current.spot, change.prior.mistakes, change.prior.spot)}</span>
                      <span>
                        <TrendTag trend={change.trend} /> <span className="muted">— {summary.trendNotes[change.trend]}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
