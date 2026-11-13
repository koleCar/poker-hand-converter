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
import {
  addAnswer,
  emptySession,
  nextSeed,
  sessionAccuracy,
  STREAK_GRADES,
  type GradedAnswer,
  type SessionStats,
  type TrainerAnswer,
  type TrainerSpot,
} from "../../lib/training";
import type { FocusArea } from "../../lib/training/plan";
import { leakKind } from "../../lib/analysis/leaks";
import { feltOf } from "./felt";
import { Feedback, Verdict } from "./Feedback";
import { focusTarget, HANDS_PER_AREA, trainableAreas } from "./focus";
import { useTrainerHost, type FocusState } from "./host";
import { SettingsSheet } from "./SettingsSheet";
import { spotOptions, targetSettings, TRAINER_MODES, type StreetMode, type TrainerSettings } from "./settings";
import { ActionStrip, SpotFelt } from "./SpotFelt";
import styles from "./trainer.module.css";

/** Seeds tried before saying no spot matches. */
const DEAL_TRIES = 3;
/** How long a right answer stays on screen before the next hand, when the trainer waits only after mistakes. */
const AUTO_NEXT_MS = 1600;

type Dealt = { key: string; spot: TrainerSpot | null; error: string | null };
type Answered = { key: string; picked: number; graded: GradedAnswer | null; error: string | null };

interface Button {
  label: string;
  tone: string;
  alias: "fold" | "check" | "call" | "allin" | null;
}

const LETTER: Record<string, string> = { fold: "F", check: "C", call: "C", allin: "A" };

export function Trainer({ initial }: { initial: TrainerSettings }) {
  const host = useTrainerHost();
  const { t } = host;
  const [settings, setSettings] = useState<TrainerSettings>(initial);
  const [sheet, setSheet] = useState(false);
  const [round, setRound] = useState(0);
  const [dealt, setDealt] = useState<Dealt | null>(null);
  const [answered, setAnswered] = useState<Answered | null>(null);
  const [session, setSession] = useState<SessionStats>(emptySession);
  const [focus, setFocus] = useState<FocusState>({ status: "loading" });
  const [areaIndex, setAreaIndex] = useState(0);
  /** Hands answered in the current area of "For you". */
  const inArea = useRef(0);
  const [holding, setHolding] = useState(false);

  const change = useCallback(
    (patch: Partial<TrainerSettings>) => {
      setSettings((current) => {
        const next = { ...current, ...patch };
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

  const requestJson = plan ? JSON.stringify(spotOptions(plan.mode, plan.settings)) : null;
  const requestKey = requestJson ? `${requestJson}|${round}` : null;

  useEffect(() => {
    if (!requestJson || !requestKey) return;
    let live = true;
    const request = JSON.parse(requestJson);
    (async () => {
      for (let attempt = 0; attempt < DEAL_TRIES; attempt += 1) {
        const spot = await host.deal(request, nextSeed());
        if (spot) return spot;
      }
      return null;
    })()
      .then((spot) => live && setDealt({ key: requestKey, spot, error: null }))
      .catch((error: unknown) => live && setDealt({ key: requestKey, spot: null, error: error instanceof Error ? error.message : String(error) }));
    return () => {
      live = false;
    };
  }, [requestJson, requestKey, host]);

  const current = dealt && dealt.key === requestKey ? dealt : null;
  const spot = current?.spot ?? null;
  const answer = answered && answered.key === requestKey ? answered : null;
  const graded = answer?.graded ?? null;
  const decision = graded?.decision ?? null;
  const felt = useMemo(() => (spot ? feltOf(spot.hand, spot.kind === "preflop" ? [] : spot.board) : null), [spot]);

  const buttons = useMemo<Button[]>(() => {
    if (!spot) return [];
    if (spot.kind === "preflop") {
      return spot.menu.map((item) => ({
        label: t.words.chartAction(item.action, item.toBb),
        tone: item.action,
        alias: item.action === "fold" || item.action === "call" || item.action === "check" || item.action === "allin" ? item.action : null,
      }));
    }
    return spot.menu.map((item) => {
      const action = item.kind === "allin" ? (spot.toCallBb > 0 ? "raise" : "bet") : item.kind;
      const sized = item.kind === "bet" || item.kind === "raise" || item.kind === "allin";
      return {
        label: t.words.option(action, sized ? item.to : undefined, item.kind === "allin", item.kind === "bet" ? item.sizePot : undefined),
        tone: item.kind,
        alias: item.kind === "fold" || item.kind === "check" || item.kind === "call" || item.kind === "allin" ? item.kind : null,
      };
    });
  }, [spot, t]);

  const next = useCallback(() => {
    setHolding(false);
    setRound((value) => value + 1);
  }, []);

  const pick = useCallback(
    (index: number) => {
      if (!spot || answer || !requestKey) return;
      const key = requestKey;
      setAnswered({ key, picked: index, graded: null, error: null });
      host
        .grade(spot, index)
        .then((result) => {
          setAnswered((prev) => (prev && prev.key === key ? { ...prev, graded: result } : prev));
          const d = result.decision;
          if (!d || d.grade === null) return;
          const scored: TrainerAnswer = { grade: d.grade, evLoss: d.evLoss ?? 0, evLossPot: d.evLossPot ?? 0, score: d.score ?? 0 };
          setSession((stats) => addAnswer(stats, scored));
          host.record?.(spot, scored, d.facts.handClass);
          if (settings.mode === "focus") {
            inArea.current += 1;
            if (inArea.current >= HANDS_PER_AREA) {
              inArea.current = 0;
              setAreaIndex((i) => i + 1);
            }
          }
          if (settings.pause === "mistakes" && STREAK_GRADES.includes(d.grade)) setHolding(true);
        })
        .catch((error: unknown) => {
          setAnswered((prev) => (prev && prev.key === key ? { ...prev, error: error instanceof Error ? error.message : String(error) } : prev));
        });
    },
    [spot, answer, requestKey, host, settings.mode, settings.pause],
  );

  // A right answer moves on by itself when the trainer waits only after mistakes.
  const holdRef = useRef<number | null>(null);
  useEffect(() => {
    if (!holding) return;
    holdRef.current = window.setTimeout(next, AUTO_NEXT_MS);
    return () => {
      if (holdRef.current !== null) window.clearTimeout(holdRef.current);
    };
  }, [holding, next]);

  // Keys: 1–9 the buttons in order, F fold, C check or call, A all-in, N / Enter next, S settings.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || sheet) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      const key = event.key.toLowerCase();
      if (key === "s") {
        setSheet(true);
        event.preventDefault();
        return;
      }
      if (answer) {
        if ((key === "n" || key === "enter") && (graded || answer.error)) {
          next();
          event.preventDefault();
        }
        return;
      }
      if (!spot) return;
      const digit = Number.parseInt(key, 10);
      if (digit >= 1 && digit <= buttons.length) {
        pick(digit - 1);
        event.preventDefault();
        return;
      }
      const alias = key === "f" ? ["fold"] : key === "c" || key === "x" ? ["check", "call"] : key === "a" ? ["allin"] : [];
      const index = buttons.findIndex((button) => button.alias !== null && alias.includes(button.alias));
      if (index >= 0) {
        pick(index);
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [answer, graded, spot, buttons, pick, next, sheet]);

  const dealing = plan !== null && current === null;
  const accuracy = sessionAccuracy(session);
  const mode = plan?.mode ?? null;
  const area = plan?.area ?? null;
  const summary = plan && settings.mode !== "focus" ? spotSummary(plan.mode, plan.settings, t) : null;

  return (
    <div className={styles.trainer}>
      <div className={styles.top}>
        <nav className={styles.modes} aria-label={t.modesLabel}>
          {TRAINER_MODES.map((id) => (
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
        <button type="button" className={styles.settingsButton} onClick={() => setSheet(true)} aria-keyshortcuts="S">
          {summary ? <span className={styles.summary}>{summary}</span> : null}
          <span className={styles.gear} aria-hidden="true">
            ⚙
          </span>
          <span>{t.settings}</span>
        </button>
      </div>

      {settings.mode === "focus" ? <FocusBar state={focus} area={area} onNext={() => {
            inArea.current = 0;
            setAreaIndex((i) => i + 1);
          }} hasAreas={areas.length > 0} /> : null}

      <div className={styles.layout}>
        <div className={styles.play}>
          {current?.error ? (
            <div className={styles.notice}>
              <p>{t.failed(current.error)}</p>
              <button type="button" className={styles.linkButton} onClick={next}>
                {t.retry}
              </button>
            </div>
          ) : null}
          {current && !current.error && !spot ? <p className={styles.notice}>{t.noSpot}</p> : null}

          {dealing || plan === null ? (
            <div className={styles.loading}>
              <RailLoader
                label={plan === null ? t.focus.loading : mode === "flop" ? t.loadingFlop : mode === "turn" || mode === "river" ? t.solving : t.dealing}
                showLabel
                centered
              />
            </div>
          ) : null}

          {spot && felt && !dealing ? (
            <div className={`${styles.spot} rail-fade`}>
              <ActionStrip items={felt.strip} />
              <SpotFelt
                felt={felt}
                cards={spot.cards}
                toCallBb={spot.toCallBb}
                overlay={decision && decision.grade ? <Verdict decision={decision} /> : null}
              />
              <div className={styles.buttons} role="group" aria-label={t.yourMove}>
                {buttons.map((button, index) => {
                  const keys = [String(index + 1), button.alias ? LETTER[button.alias] : null].filter(Boolean) as string[];
                  const option = decision?.chosen === index ? "chosen" : undefined;
                  return (
                    <button
                      key={index}
                      type="button"
                      className={styles.action}
                      data-action={button.tone}
                      data-picked={answer?.picked === index || option ? true : undefined}
                      disabled={Boolean(answer)}
                      aria-keyshortcuts={keys.join(" ")}
                      onClick={() => pick(index)}
                    >
                      <span>{button.label}</span>
                      <kbd aria-hidden="true">{keys[0]}</kbd>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {answer && !graded && !answer.error ? (
            <p className={styles.status}>
              <RailLoader size="inline" label={t.grading} showLabel />
            </p>
          ) : null}
          {answer?.error ? <p className={styles.notice}>{t.failed(answer.error)}</p> : null}

          {graded && spot ? (
            <div className={styles.after}>
              <div className={styles.nextRow}>
                {holding ? (
                  <>
                    <span className={styles.muted}>{t.autoNext}</span>
                    <button type="button" className={styles.linkButton} onClick={() => setHolding(false)}>
                      {t.stay}
                    </button>
                  </>
                ) : null}
                <button type="button" className={styles.next} onClick={next} aria-keyshortcuts="N Enter">
                  {t.next}
                  <kbd aria-hidden="true">N</kbd>
                </button>
              </div>
              {decision ? <Feedback decision={decision} spot={spot} settings={plan?.settings ?? settings} /> : null}
              {host.study ? host.study(graded, spot) : null}
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
              <dd data-loss={session.evLoss > 0 || undefined}>
                {t.lostBb(session.evLoss)}
              </dd>
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

