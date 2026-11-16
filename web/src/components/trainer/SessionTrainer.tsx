/**
 * Training in one session: its settings fixed (`sessions.ts`), the spots or
 * whole hands they deal, and beside them the session's figures - today's or
 * all of them - from every answer it holds. The name opens the session's
 * menu; "Change settings" starts a new session (the sheet says so). Spots
 * the session has dealt before come back now and then (settings → Repeat
 * played spots), and after the answer the player sees what they played then.
 *
 * Every async step is keyed (`mode | request | round`): a slow deal or grade
 * for an old spot never lands on a new one.
 */

"use client";

import { RailLoader } from "@rail/ui/loader/RailLoader";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GRADES } from "../../lib/analysis/types";
import { CHART_SETS } from "../../lib/charts";
import type { FocusArea } from "../../lib/training/plan";
import { leakKind } from "../../lib/analysis/leaks";
import { focusTarget, HANDS_PER_AREA, trainableAreas } from "./focus";
import { useTrainerHost, type FocusState, type TrainerDict } from "./host";
import { HandPlayer } from "./HandPlayer";
import { HAND_MODES, playOptions, setFor, spotOptions, targetSettings, unavailable, type StreetMode, type TrainerSettings } from "./settings";
import { Fold, Tick } from "./Session";
import { earlierOn, figuresOf, pickRepeat, sessionSettings, todayOf, type SessionAnswer, type SpotRef, type TrainerSession } from "./sessions";
import { SpotPlayer, type TableStatus } from "./SpotPlayer";
import { TableBox } from "./TrainerTable";
import styles from "./trainer.module.css";

export interface SessionTrainerProps {
  session: TrainerSession;
  /** The session's answers so far, oldest first. */
  answers: readonly SessionAnswer[];
  onAnswer: (answer: SessionAnswer) => void;
  /** A spot to deal first ("Play it again" in the review). */
  again?: SessionAnswer | null;
  onSessions: () => void;
  onReview: () => void;
  onChangeSettings: () => void;
  onRename: (name: string) => void;
}

export function SessionTrainer({ session, answers, onAnswer, again = null, onSessions, onReview, onChangeSettings, onRename }: SessionTrainerProps) {
  const host = useTrainerHost();
  const { t } = host;
  const settings = useMemo(() => sessionSettings(session), [session]);
  const [focus, setFocus] = useState<FocusState>({ status: "loading" });
  const [areaIndex, setAreaIndex] = useState(0);
  /** Answers (spots) or hands in the current area of "For you". */
  const inArea = useRef(0);
  const [statuses, setStatuses] = useState<TableStatus[]>([]);
  const [period, setPeriod] = useState<"today" | "all">("today");

  // The answers as they are now, for the deals (read when a spot is dealt, not a reason to deal again).
  const answersRef = useRef(answers);
  useEffect(() => {
    answersRef.current = answers;
  }, [answers]);
  const forced = useRef<SessionAnswer[]>(again?.ref ? [again] : []);

  // "For you": read the leaks once.
  const wantsFocus = settings.mode === "focus";
  useEffect(() => {
    if (!wantsFocus || focus.status !== "loading") return;
    let live = true;
    host
      .focus()
      .then((state) => live && setFocus(state))
      .catch((error: unknown) => live && setFocus({ status: "error", message: error instanceof Error ? error.message : String(error) }));
    return () => {
      live = false;
    };
  }, [wantsFocus, focus.status, host]);

  const areas = useMemo<FocusArea[]>(() => (focus.status === "ready" ? trainableAreas(focus.areas) : []), [focus]);

  // What to deal now: the mode's own settings, or in "For you" the current area's (or the general list's) target.
  const plan = useMemo<{ mode: StreetMode; settings: TrainerSettings; area: FocusArea | null } | null>(() => {
    if (settings.mode !== "focus") return { mode: settings.mode, settings, area: null };
    if (focus.status === "loading") return null;
    const { area, target } = focusTarget(areas, areaIndex);
    const shaped = targetSettings(target, settings);
    return { mode: shaped.mode, settings: shaped.settings, area };
  }, [settings, focus.status, areas, areaIndex]);

  const canPlayHands = Boolean(host.playStart && host.playGrade && host.playAnswer);
  const handMode = settings.play === "hand" && canPlayHands && HAND_MODES.includes(settings.mode);
  const blocked = plan ? unavailable(plan.mode, plan.settings, handMode) : null;
  const playRequest = useMemo(() => (handMode && plan && !blocked ? playOptions(plan.mode, plan.settings) : null), [handMode, plan, blocked]);
  const spotRequest = useMemo(() => (!handMode && plan && !blocked ? spotOptions(plan.mode, plan.settings) : null), [handMode, plan, blocked]);
  const tables = handMode ? 1 : Number(settings.tables) || 1;

  const counted = useCallback(
    (step: number) => {
      if (settings.mode !== "focus") return;
      inArea.current += 1;
      if (inArea.current >= step) {
        inArea.current = 0;
        setAreaIndex((i) => i + 1);
      }
    },
    [settings.mode],
  );
  const scored = useCallback(() => {
    if (!handMode) counted(HANDS_PER_AREA);
  }, [handMode, counted]);
  const handDone = useCallback(() => counted(Math.ceil(HANDS_PER_AREA / 2)), [counted]);

  /** A spot to deal again: one queued by "Play it again", else now and then one of the session's own. */
  const pickRef = useCallback((): { ref: SpotRef; key: string } | null => {
    const queued = forced.current.shift();
    if (queued?.ref) return { ref: queued.ref, key: queued.spotKey };
    const back = pickRepeat(answersRef.current, settings.repeat, Math.random(), Math.random());
    return back?.ref ? { ref: back.ref, key: back.spotKey } : null;
  }, [settings.repeat]);
  const earlier = useCallback((key: string) => earlierOn(answersRef.current, key), []);

  const statusOf = useCallback(
    (index: number) => (status: TableStatus) =>
      setStatuses((current) => {
        if (current[index] === status) return current;
        const next = [...current];
        next[index] = status;
        return next;
      }),
    [],
  );
  const reporters = useMemo(() => Array.from({ length: 4 }, (_, i) => statusOf(i)), [statusOf]);
  const live = statuses.slice(0, tables);
  const waiting = live.findIndex((status) => status === "waiting");
  const answeredAt = live.findIndex((status) => status === "answered");
  const keysFor = (index: number): "answer" | "next" | null =>
    waiting >= 0 ? (index === waiting ? "answer" : null) : index === answeredAt ? "next" : null;

  // S: change the settings (a new session).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if (document.querySelector("[aria-modal='true']")) return;
      if (event.key.toLowerCase() === "s") {
        onChangeSettings();
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onChangeSettings]);

  const shown = useMemo(() => (period === "today" ? todayOf(answers) : answers), [answers, period]);
  const figures = useMemo(() => figuresOf(shown), [shown]);
  const all = useMemo(() => figuresOf(answers), [answers]);
  const streak = useMemo(() => {
    let n = 0;
    for (let i = answers.length - 1; i >= 0 && (answers[i].grade === "perfect" || answers[i].grade === "good"); i -= 1) n += 1;
    return n;
  }, [answers]);
  const area = plan?.area ?? null;
  const s = t.sessions;

  return (
    <div className={styles.trainer}>
      <div className={styles.top}>
        <SessionMenu session={session} onSessions={onSessions} onReview={onReview} onNew={onChangeSettings} onRename={onRename} />
        <span className={styles.locked} title={s.locked}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
          {lockedSummary(settings, t)}
        </span>
        <button type="button" className={styles.settingsButton} onClick={onChangeSettings} aria-keyshortcuts="S">
          <span className={styles.gear} aria-hidden="true">
            ⚙
          </span>
          <span>{s.changeSettings}</span>
        </button>
      </div>

      {settings.mode === "focus" ? (
        <FocusBar
          state={focus}
          area={area}
          onNext={() => {
            inArea.current = 0;
            setAreaIndex((i) => i + 1);
          }}
          hasAreas={areas.length > 0}
        />
      ) : null}

      <div className={styles.layout} data-tables={tables > 1 ? tables : undefined}>
        <div className={styles.play}>
          {plan === null ? (
            <div className={styles.spot}>
              <div className={styles.stripSpace} aria-hidden="true" />
              <TableBox>
                <div className={styles.loading}>
                  <RailLoader label={t.focus.loading} showLabel centered />
                </div>
              </TableBox>
            </div>
          ) : null}
          {blocked ? (
            <div className={styles.notice}>
              <p>{blocked === "flop" ? t.unavailable.flop : t.unavailable.set}</p>
            </div>
          ) : null}
          {handMode && playRequest ? (
            <HandPlayer request={playRequest} settings={plan?.settings ?? settings} onScored={scored} onAnswer={onAnswer} onHandDone={handDone} />
          ) : null}
          {!handMode && spotRequest && plan ? (
            <div className={styles.tables} data-count={tables}>
              {Array.from({ length: tables }, (_, i) => (
                <SpotPlayer
                  key={i}
                  request={spotRequest}
                  mode={plan.mode}
                  settings={plan.settings}
                  keys={keysFor(i)}
                  compact={tables > 1}
                  onScored={scored}
                  onStatus={reporters[i]}
                  pickRef={pickRef}
                  onAnswer={onAnswer}
                  earlier={earlier}
                />
              ))}
            </div>
          ) : null}
        </div>

        <aside className={styles.side} aria-label={t.session.label}>
          <div className={styles.sideHead}>
            <div className={styles.period} role="group" aria-label={t.session.label}>
              {(["today", "all"] as const).map((id) => (
                <button key={id} type="button" className={styles.mode} aria-pressed={period === id} onClick={() => setPeriod(id)}>
                  {s.periods[id]}
                </button>
              ))}
            </div>
            <button type="button" className={styles.linkButton} onClick={onReview}>
              {s.review}
            </button>
          </div>
          <dl className={styles.stats}>
            <div>
              <dt>{s.hands}</dt>
              <dd>
                <Tick value={figures.hands.toLocaleString(host.locale)} />
              </dd>
            </div>
            <div>
              <dt>{s.score}</dt>
              <dd data-score={scoreBand(figures.score)}>
                <Tick value={figures.score === null ? "—" : Math.round(figures.score).toLocaleString(host.locale)} />
              </dd>
            </div>
            <div>
              <dt>{t.session.streak}</dt>
              <dd>
                <Tick value={streak.toLocaleString(host.locale)} />
                <span className={styles.muted}> / {figures.bestStreak.toLocaleString(host.locale)}</span>
              </dd>
            </div>
            <div>
              <dt>{t.session.evLost}</dt>
              <dd data-loss={figures.evLoss > 0 || undefined}>
                <Tick value={t.lostBb(figures.evLoss)} />
              </dd>
            </div>
          </dl>
          <ol className={styles.history} aria-hidden="true" data-empty={figures.hands === 0 || undefined}>
            {GRADES.map((grade) => (
              <li key={grade} data-grade={grade} style={{ flexGrow: figures.counts[grade] }} title={`${t.words.grades[grade]}: ${figures.counts[grade]}`} />
            ))}
          </ol>
          {all.repeated > 0 ? (
            <div className={styles.again}>
              <span className={styles.againHead}>
                <span>{s.playedAgain}</span>
                <span className={styles.muted}>{s.spots(all.repeated)}</span>
              </span>
              <span className={styles.againBar}>
                <i style={{ inlineSize: `${(all.repeatedRight / all.repeated) * 100}%` }} />
              </span>
              <span className={styles.muted}>
                {s.rightNow(all.repeatedRight / all.repeated)} · {s.mistakesFirst}
              </span>
            </div>
          ) : null}
          {host.aside}
          <Fold id="keys" label={t.keysHeading}>
            <p className={styles.keys}>{t.keys}</p>
          </Fold>
        </aside>
      </div>
    </div>
  );
}

/** A score's band for its colour: green high, shading to red low. */
export function scoreBand(score: number | null): string | undefined {
  if (score === null) return undefined;
  return score >= 80 ? "high" : score >= 70 ? "good" : score >= 60 ? "mid" : "low";
}

/** The session's name: its menu (all sessions, the history, rename, a new session). */
function SessionMenu({
  session,
  onSessions,
  onReview,
  onNew,
  onRename,
}: {
  session: TrainerSession;
  onSessions: () => void;
  onReview: () => void;
  onNew: () => void;
  onRename: (name: string) => void;
}) {
  const { t } = useTrainerHost();
  const s = t.sessions;
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);
  if (renaming !== null) {
    return (
      <form
        className={styles.renameForm}
        onSubmit={(event) => {
          event.preventDefault();
          if (renaming.trim()) onRename(renaming.trim());
          setRenaming(null);
        }}
      >
        <input className={styles.input} value={renaming} maxLength={60} autoFocus onChange={(event) => setRenaming(event.target.value)} onKeyDown={(event) => event.key === "Escape" && setRenaming(null)} aria-label={s.name} />
        <button type="submit" className={styles.chip}>
          {s.renameSave}
        </button>
      </form>
    );
  }
  return (
    <div className={styles.menuBox} ref={box}>
      <button type="button" className={styles.sessionName} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((v) => !v)}>
        <strong>{session.name}</strong>
        <span aria-hidden="true" className={styles.chevron}>
          ▾
        </span>
      </button>
      {open ? (
        <div className={styles.menu} role="menu">
          <button type="button" role="menuitem" onClick={onSessions}>
            {s.all}
          </button>
          <button type="button" role="menuitem" onClick={onReview}>
            {s.review}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setRenaming(session.name);
            }}
          >
            {s.rename}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onNew();
            }}
          >
            {s.newSession}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function FocusBar({ state, area, onNext, hasAreas }: { state: FocusState; area: FocusArea | null; onNext: () => void; hasAreas: boolean }) {
  const { t } = useTrainerHost();
  if (state.status === "loading") return null;
  if (state.status === "signed-out") return <p className={styles.focus}>{t.focus.signIn}</p>;
  if (!area || !hasAreas) return <p className={styles.focus}>{t.focus.none}</p>;
  const top = area.leaks[0];
  const where = area.where;
  const title = top ? t.words.leakTitle(leakKind(top.taken, top.best), where) : t.words.leakContext(where, area.level, area.partial);
  const context = t.words.leakContext(where, area.level, area.partial);
  return (
    <div className={styles.focus}>
      <span className={styles.focusLabel}>{t.focus.working}</span>
      <strong>{title}</strong>
      <span className={styles.muted}>{context}</span>
      {area.per100 > 0 ? <span className={styles.focusCost}>{t.focus.costs(area.per100)}</span> : null}
      <button type="button" className={styles.linkButton} onClick={onNext}>
        {t.focus.nextArea}
      </button>
    </div>
  );
}

/** "6-max 100bb · Preflop · One spot · vs open · BB vs BTN · Close spots · Repeats sometimes": the session's settings in one line. */
export function lockedSummary(s: TrainerSettings, t: TrainerDict): string {
  const parts: string[] = [];
  const mode: StreetMode | null = s.mode === "focus" ? null : s.mode;
  const set = setFor(s.mode, s.set);
  const spec = CHART_SETS.find((one) => one.id === set);
  parts.push(spec ? t.tableValue(spec.players, spec.stackBb, Boolean(spec.straddle), Boolean(spec.ante)) : set);
  parts.push(t.modes[s.mode] ?? s.mode);
  parts.push(t.play[s.play]);
  if (mode === "preflop") {
    if (s.family !== "random") parts.push(t.families[s.family] ?? s.family);
    if (s.seat || s.vs) parts.push([s.seat ?? t.any, s.vs ? `${t.vs.toLowerCase()} ${s.vs}` : null].filter(Boolean).join(" "));
  } else if (mode) {
    if (s.seat) parts.push(s.seat);
    if (s.pot !== "any") parts.push(t.pots[s.pot] ?? s.pot);
    if (s.side !== "any") parts.push(t.sides[s.side] ?? s.side);
    if (s.role !== "any") parts.push(t.roles[s.role] ?? s.role);
    if (s.facing !== "any") parts.push(`${t.facing.toLowerCase()} ${(t.facings[s.facing] ?? s.facing).toLowerCase()}`);
    if (mode === "flop" && s.line) parts.push(t.words.lineName(s.line));
  }
  parts.push(t.deals[s.deal] ?? s.deal);
  if (s.play === "spot") parts.push(`${t.sessions.repeatLabel}: ${(t.sessions.repeats[s.repeat] ?? s.repeat).toLowerCase()}`);
  return parts.join(" · ");
}
