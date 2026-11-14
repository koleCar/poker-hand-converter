/**
 * The Trainer: a poker spot on a table, the moves as buttons, and after the
 * answer the grade, what the reference does with the hand and why.
 *
 * Modelled on GTO Wizard's trainer (the felt, the action strip, the coloured
 * action buttons, a quick verdict, a settings sheet), on Rail's own reference
 * - the charts, the flop library and the turn and river solved on the spot -
 * and graded by the analysis itself (`lib/training`): a trainer answer is the
 * analysis' grade of the same spot by construction. "For you" deals from the
 * player's own leaks ({@link trainableAreas}).
 *
 * Host-neutral (`host.tsx`): the web and the desktop app render it in place.
 * Every async step is keyed (`mode | request | round`): a slow deal or grade
 * for an old spot never lands on a new one.
 */

"use client";

import { RailLoader } from "@rail/ui/loader/RailLoader";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { addAnswer, emptySession, sessionAccuracy, type SessionStats, type TrainerAnswer } from "../../lib/training";
import type { FocusArea } from "../../lib/training/plan";
import { leakKind } from "../../lib/analysis/leaks";
import { focusTarget, HANDS_PER_AREA, trainableAreas } from "./focus";
import { useTrainerHost, type FocusState } from "./host";
import { SettingsSheet } from "./SettingsSheet";
import { HandPlayer } from "./HandPlayer";
import { HAND_MODES, PLAYS, playOptions, spotOptions, targetSettings, TRAINER_MODES, unavailable, type StreetMode, type TrainerSettings } from "./settings";
import { SpotPlayer, type TableStatus } from "./SpotPlayer";
import styles from "./trainer.module.css";

export function Trainer({ initial }: { initial: TrainerSettings }) {
  const host = useTrainerHost();
  const { t } = host;
  const [settings, setSettings] = useState<TrainerSettings>(initial);
  const [sheet, setSheet] = useState(false);
  const [session, setSession] = useState<SessionStats>(emptySession);
  const [focus, setFocus] = useState<FocusState>({ status: "loading" });
  const [areaIndex, setAreaIndex] = useState(0);
  /** Answers (spots) or hands in the current area of "For you". */
  const inArea = useRef(0);
  const [statuses, setStatuses] = useState<TableStatus[]>([]);

  const change = useCallback(
    (patch: Partial<TrainerSettings>) => {
      setSettings((current) => {
        const next = { ...current, ...patch };
        // A whole hand starts preflop or on the flop: a turn or river spot mode becomes the flop.
        if (next.play === "hand" && !HAND_MODES.includes(next.mode)) next.mode = "flop";
        host.onSettings?.(next);
        return next;
      });
    },
    [host],
  );

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
  // A whole hand (T2) when the host can play one and the mode starts one; spots otherwise.
  const handMode = settings.play === "hand" && canPlayHands && HAND_MODES.includes(settings.mode);
  // Nothing to deal (no flop library, a set not transcribed yet): said, never dealt from something else.
  const blocked = plan ? unavailable(plan.mode, plan.settings, handMode) : null;
  const playRequest = useMemo(() => (handMode && plan && !blocked ? playOptions(plan.mode, plan.settings) : null), [handMode, plan, blocked]);
  const spotRequest = useMemo(() => (!handMode && plan && !blocked ? spotOptions(plan.mode, plan.settings) : null), [handMode, plan, blocked]);
  // Several tables in spot mode only (T5); a whole hand is one table.
  const tables = handMode ? 1 : Number(settings.tables) || 1;

  const counted = useCallback(
    (step: number) => {
      // "For you" works through an area a few answers (or hands) at a time.
      if (settings.mode !== "focus") return;
      inArea.current += 1;
      if (inArea.current >= step) {
        inArea.current = 0;
        setAreaIndex((i) => i + 1);
      }
    },
    [settings.mode],
  );
  const scored = useCallback(
    (answer: TrainerAnswer) => {
      setSession((stats) => addAnswer(stats, answer));
      if (!handMode) counted(HANDS_PER_AREA);
    },
    [handMode, counted],
  );
  const handDone = useCallback(() => counted(Math.ceil(HANDS_PER_AREA / 2)), [counted]);

  // Keys go to one table: the first waiting for an answer, else the first answered (for "next").
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

  // S opens the settings, whatever the mode.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || sheet) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if (event.key.toLowerCase() === "s") {
        setSheet(true);
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheet]);

  const accuracy = sessionAccuracy(session);
  const area = plan?.area ?? null;
  const summary = plan && settings.mode !== "focus" ? spotSummary(plan.mode, plan.settings, t) : null;

  return (
    <div className={styles.trainer}>
      <div className={styles.top}>
        <nav className={styles.modes} aria-label={t.modesLabel}>
          {TRAINER_MODES.filter((id) => settings.play !== "hand" || !canPlayHands || HAND_MODES.includes(id)).map((id) => (
            <button
              key={id}
              type="button"
              className={styles.mode}
              aria-pressed={settings.mode === id}
              title={t.modeHints[id]}
              onClick={() => change({ mode: id })}
            >
              {t.modes[id]}
            </button>
          ))}
          {host.extraModes}
        </nav>
        {canPlayHands ? (
          <div className={styles.playSwitch} role="group" aria-label={t.play.label}>
            {PLAYS.map((id) => (
              <button key={id} type="button" className={styles.mode} aria-pressed={settings.play === id} onClick={() => change({ play: id })}>
                {t.play[id]}
              </button>
            ))}
          </div>
        ) : null}
        <button type="button" className={styles.settingsButton} onClick={() => setSheet(true)} aria-keyshortcuts="S">
          {summary ? <span className={styles.summary}>{summary}</span> : null}
          <span className={styles.gear} aria-hidden="true">
            ⚙
          </span>
          <span>{t.settings}</span>
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
            <div className={styles.loading}>
              <RailLoader label={t.focus.loading} showLabel centered />
            </div>
          ) : null}
          {blocked ? (
            <div className={styles.notice}>
              <p>{blocked === "flop" ? t.unavailable.flop : t.unavailable.set}</p>
            </div>
          ) : null}
          {handMode && playRequest ? (
            <HandPlayer request={playRequest} settings={plan?.settings ?? settings} onScored={scored} onHandDone={handDone} />
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
                />
              ))}
            </div>
          ) : null}
        </div>

        <aside className={styles.side} aria-label={t.session.label}>
          <dl className={styles.stats}>
            <div>
              <dt>{t.session.answers}</dt>
              <dd>{session.answers.toLocaleString(host.locale)}</dd>
            </div>
            <div>
              <dt>{t.session.accuracy}</dt>
              <dd>{accuracy === null ? "—" : `${Math.round(accuracy * 100).toLocaleString(host.locale)}%`}</dd>
            </div>
            <div>
              <dt>{t.session.streak}</dt>
              <dd>
                {session.streak.toLocaleString(host.locale)}
                <span className={styles.muted}> / {session.bestStreak.toLocaleString(host.locale)}</span>
              </dd>
            </div>
            <div>
              <dt>{t.session.evLost}</dt>
              <dd data-loss={session.evLoss > 0 || undefined}>{t.lostBb(session.evLoss)}</dd>
            </div>
          </dl>
          {session.answers > 0 ? (
            <ol className={styles.history} aria-hidden="true">
              {(["perfect", "good", "inaccurate", "mistake", "blunder"] as const).map((grade) =>
                session.counts[grade] > 0 ? (
                  <li key={grade} data-grade={grade} style={{ flexGrow: session.counts[grade] }} title={`${t.words.grades[grade]}: ${session.counts[grade]}`} />
                ) : null,
              )}
            </ol>
          ) : null}
          <button type="button" className={styles.linkButton} onClick={() => setSession(emptySession())} disabled={session.answers === 0}>
            {t.session.reset}
          </button>
          <p className={styles.keys}>{t.keys}</p>
          {host.aside}
        </aside>
      </div>

      <SettingsSheet open={sheet} settings={settings} onChange={change} onClose={() => setSheet(false)} />
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

/** "Preflop · vs open · BB vs BTN · 6-max 100bb": what the settings deal, in one line. */
function spotSummary(mode: StreetMode, s: TrainerSettings, t: ReturnType<typeof useTrainerHost>["t"]): string {
  const parts: string[] = [];
  if (mode === "preflop") {
    if (s.family !== "random") parts.push(t.families[s.family] ?? s.family);
    if (s.seat || s.vs) parts.push([s.seat ?? t.any, s.vs ? `${t.vs.toLowerCase()} ${s.vs}` : null].filter(Boolean).join(" "));
  } else {
    if (s.pot !== "any") parts.push(t.pots[s.pot] ?? s.pot);
    if (s.side !== "any") parts.push(t.sides[s.side] ?? s.side);
    if (s.role !== "any") parts.push(t.roles[s.role] ?? s.role);
    if (s.facing !== "any") parts.push(`${t.facing.toLowerCase()} ${(t.facings[s.facing] ?? s.facing).toLowerCase()}`);
    if (mode === "flop" && s.line) parts.push(t.words.lineName(s.line));
  }
  return parts.join(" · ");
}

