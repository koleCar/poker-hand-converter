/**
 * A whole hand in the Trainer (T2): the hero against one opponent, from
 * preflop or the flop to a fold or the showdown (`lib/training/play.ts`).
 *
 * Each hero decision is the spot trainer's: the table, the buttons, the grade
 * under the table and the feedback in tabs. The table stays for the whole
 * hand and steps on from each answer to the next decision. While the player reads the
 * feedback, the hand is already played on in the worker (the opponent's
 * moves from the reference, the next street), so "Continue" is usually
 * instant; on a turn or river the opponent's solve can take a few seconds.
 * At the end: the result in bb, the opponent's cards at a showdown, and
 * every decision of the hand with its grade.
 */

"use client";

import { RailLoader } from "@rail/ui/loader/RailLoader";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DecisionAnalysis, OptionAnalysis } from "../../lib/analysis/types";
import { nextSeed, STREAK_GRADES, type GradedAnswer, type TrainerAnswer } from "../../lib/training";
import type { PlayOptions, PlayStep } from "../../lib/training/play";
import { ActionButtons, buttonInfo, groupChoices, groupForKey, TimebankBar, useTimebank, type Choice } from "./Decision";
import { feltOf } from "./felt";
import { DecisionPanel } from "./DecisionPanel";
import { bestIndex, useOptionText, Verdict } from "./Feedback";
import { useTrainerHost } from "./host";
import type { TrainerSettings } from "./settings";
import { answerMix, cardsText, handDecisionKey, type SessionAnswer } from "./sessions";
import { ActionStrip, StatusRow } from "./SpotFelt";
import { TableBox, TrainerTable, type HeroMove } from "./TrainerTable";
import styles from "./trainer.module.css";
import { Dismissible } from "@rail/ui/notice/Dismissible";

const DEAL_TRIES = 4;
const AUTO_NEXT_MS = 1600;
const GLYPH: Record<string, string> = { perfect: "★", good: "✓", inaccurate: "?!", mistake: "?", blunder: "??" };

interface Answered {
  picked: number;
  graded: GradedAnswer | null;
  error: string | null;
}

interface LogRow {
  street: string;
  label: string;
  decision: DecisionAnalysis;
}

function tone(option: OptionAnalysis): string {
  return option.allIn ? "allin" : option.action;
}

/** The same option of two analyses of one node: the action, the all-in and the size. */
function sameOption(a: OptionAnalysis, b: OptionAnalysis): boolean {
  const near = (x: number | undefined, y: number | undefined) => x === undefined || y === undefined || Math.abs(x - y) < 0.01;
  return a.action === b.action && Boolean(a.allIn) === Boolean(b.allIn) && near(a.sizeBb, b.sizeBb) && near(a.sizePot, b.sizePot);
}

interface HandPlayerProps {
  /** What the hand is dealt from; a new value deals a new hand. */
  request: PlayOptions;
  settings: TrainerSettings;
  onScored: (answer: TrainerAnswer) => void;
  /** Every graded decision, for the session. */
  onAnswer?: (answer: SessionAnswer) => void;
  /** A hand finished (the "For you" rotation counts hands, not answers). */
  onHandDone?: () => void;
}

/** Hands one after another: each is its own component, so a new hand starts from a clean state. */
export function HandPlayer(props: HandPlayerProps) {
  const [round, setRound] = useState(0);
  const newHand = useCallback(() => setRound((value) => value + 1), []);
  return <OneHand key={`${JSON.stringify(props.request)}|${round}`} {...props} newHand={newHand} />;
}

function OneHand({ request, settings, onScored, onAnswer, onHandDone, newHand }: HandPlayerProps & { newHand: () => void }) {
  const host = useTrainerHost();
  const optionText = useOptionText();
  const { t } = host;
  const [step, setStep] = useState<PlayStep | null>(null);
  const [dealing, setDealing] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [answered, setAnswered] = useState<Answered | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [holding, setHolding] = useState(false);
  const [log, setLog] = useState<LogRow[]>([]);
  const pending = useRef<Promise<PlayStep | null> | null>(null);
  const requestJson = JSON.stringify(request);

  // The hand, dealt once.
  useEffect(() => {
    let live = true;
    const options = JSON.parse(requestJson) as PlayOptions;
    (async () => {
      for (let attempt = 0; attempt < DEAL_TRIES; attempt += 1) {
        const dealt = await host.playStart!(options, nextSeed());
        if (dealt) return dealt;
      }
      return null;
    })()
      .then((dealt) => {
        if (!live) return;
        setStep(dealt);
        setDealing(false);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setError(e instanceof Error ? e.message : String(e));
        setDealing(false);
      });
    return () => {
      live = false;
    };
  }, [requestJson, host]);

  const decision = step?.decision ?? null;
  const over = step?.over ?? null;
  const felt = useMemo(() => {
    if (decision) return feltOf(decision.hand, decision.board);
    if (over) return feltOf(over.hand, over.board);
    return null;
  }, [decision, over]);

  const buttons = useMemo<Choice[]>(
    () =>
      (decision?.menu ?? []).map((option) => ({
        label: t.words.option(option.action, option.sizeBb, option.allIn, option.sizePot),
        tone: tone(option),
        alias: option.allIn ? "allin" : option.action === "fold" || option.action === "check" || option.action === "call" ? option.action : null,
      })),
    [decision, t],
  );
  const groups = useMemo(() => groupChoices(buttons, settings.buttons), [buttons, settings.buttons]);

  const graded = answered?.graded ?? null;
  const verdict = graded?.decision ?? null;
  // Every button's frequency, EV and grade once graded (#417): the menu is the analysis' options, matched by action and size.
  const info = useMemo(
    () =>
      decision && settings.strategy
        ? buttonInfo(verdict, groups, (index) => {
            const item = decision.menu[index];
            return item ? (verdict?.options.findIndex((o) => sameOption(o, item)) ?? -1) : -1;
          })
        : null,
    [decision, settings.strategy, verdict, groups],
  );

  // The answer on the table: the chips pushed out, or the cards folded.
  const picked = answered?.picked ?? null;
  const move = useMemo<HeroMove | null>(() => {
    const option = picked !== null ? decision?.menu[picked] : undefined;
    if (!option) return null;
    return { action: option.action as HeroMove["action"], toBb: option.sizeBb, allIn: option.allIn };
  }, [decision, picked]);

  const study = host.study && graded && verdict ? host.study(graded, null) : null;

  const pick = useCallback(
    (index: number) => {
      if (!step || !decision || answered) return;
      setAnswered({ picked: index, graded: null, error: null });
      // Played on at once: the opponent's answer is ready by the time the feedback is read.
      pending.current = host.playAnswer!(step, index);
      host
        .playGrade!(step, index)
        .then((result) => {
          setAnswered((prev) => (prev && prev.picked === index ? { ...prev, graded: result } : prev));
          const d = result.decision;
          if (!d || d.grade === null) return;
          onScored({ grade: d.grade, evLoss: d.evLoss ?? 0, evLossPot: d.evLossPot ?? 0, score: d.score ?? 0 });
          setLog((rows) => [...rows, { street: decision.street, label: buttons[index]?.label ?? "", decision: d }]);
          host.kept?.({
            at: new Date().toISOString(),
            street: decision.street,
            cards: [...decision.cards],
            label: buttons[index]?.label ?? "",
            grade: d.grade,
            evLoss: d.evLoss ?? 0,
          });
          const best = bestIndex(d);
          onAnswer?.({
            at: new Date().toISOString(),
            street: decision.street,
            cards: cardsText(decision.cards),
            board: cardsText(decision.board),
            spotKey: handDecisionKey(decision.street, d.facts.position ?? "-", decision.cards, decision.board),
            position: d.facts.position,
            handClass: d.facts.handClass,
            move: (buttons[index]?.label ?? "?").slice(0, 60) || "?",
            best: best !== null ? optionText(d.options[best]).slice(0, 60) : "",
            grade: d.grade,
            evLoss: d.evLoss ?? 0,
            score: d.score ?? 0,
            ref: null,
            ...answerMix(d),
          });
          if (settings.pause === "mistakes" && STREAK_GRADES.includes(d.grade)) setHolding(true);
        })
        .catch((e: unknown) => {
          setAnswered((prev) => (prev ? { ...prev, error: e instanceof Error ? e.message : String(e) } : prev));
        });
    },
    [step, decision, answered, host, onScored, onAnswer, optionText, buttons, settings.pause],
  );

  /** A group of sizes (one button per action): the size the reference prefers for this hand. */
  const pickGroup = useCallback(
    (g: number) => {
      const group = groups[g];
      if (!group || !decision) return;
      let best = group[0];
      for (const index of group) if ((decision.menu[index]?.freq ?? 0) > (decision.menu[best]?.freq ?? 0)) best = index;
      pick(best);
    },
    [groups, decision, pick],
  );

  // The clock: out of time, a check where there is one, else a fold.
  const seconds = Number(settings.timebank) || 0;
  const timeout = useCallback(() => {
    const check = groups.findIndex((group) => buttons[group[0]]?.tone === "check");
    const fold = groups.findIndex((group) => buttons[group[0]]?.tone === "fold");
    pickGroup(check >= 0 ? check : Math.max(0, fold));
  }, [groups, buttons, pickGroup]);
  const left = useTimebank(seconds, Boolean(decision) && !answered, timeout);

  const proceed = useCallback(() => {
    setHolding(false);
    const next = pending.current;
    if (!next) return;
    setWaiting(true);
    next
      .then((played) => {
        pending.current = null;
        setAnswered(null);
        setWaiting(false);
        setStep(played);
        if (played?.over) onHandDone?.();
      })
      .catch((e: unknown) => {
        setWaiting(false);
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [onHandDone]);

  // A right answer moves on by itself when the trainer waits only after mistakes.
  useEffect(() => {
    if (!holding) return;
    const timer = window.setTimeout(proceed, AUTO_NEXT_MS);
    return () => window.clearTimeout(timer);
  }, [holding, proceed]);

  // Keys: the buttons by number and letter; N / Enter continue or a new hand.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if (document.querySelector("[aria-modal='true']")) return;
      const key = event.key.toLowerCase();
      if (key === "n" || key === "enter") {
        if (over) newHand();
        else if (answered && (graded || answered.error) && !waiting) proceed();
        else return;
        event.preventDefault();
        return;
      }
      if (!decision || answered) return;
      const g = groupForKey(buttons, groups, key);
      if (g >= 0) {
        pickGroup(g);
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [over, answered, graded, waiting, decision, buttons, groups, pickGroup, proceed, newHand]);

  if (error) {
    return (
      <Dismissible as="div" className={styles.notice}>
        <p>{t.failed(error)}</p>
        <button type="button" className={styles.linkButton} onClick={newHand}>
          {t.retry}
        </button>
      </Dismissible>
    );
  }
  if (dealing) {
    return (
      <div className={styles.spot}>
        <div className={styles.stripSpace} aria-hidden="true" />
        <TableBox>
          <div className={styles.loading}>
            <RailLoader label={t.play.starting} showLabel centered />
          </div>
        </TableBox>
      </div>
    );
  }
  if (!step || !felt) return <p className={styles.notice}>{t.play.noHand}</p>;

  const state = step.state;
  const lost = log.reduce((sum, row) => sum + Math.max(0, row.decision.evLoss ?? 0), 0);

  return (
    <div className={`${styles.spot} rail-fade`}>
      <ActionStrip items={felt.strip} now={!over} />
      <TrainerTable
        hand={(decision ?? over)!.hand}
        board={(decision ?? over)!.board}
        heroCards={state.heroCards}
        move={move}
        waiting={Boolean(decision) && !answered}
        over={!decision && Boolean(over)}
        shown={over?.villainCards ? { position: state.villain, cards: over.villainCards } : null}
      />
      <StatusRow>
        {verdict && verdict.grade ? (
          <Verdict decision={verdict} />
        ) : over && over.reason !== "no-reference" ? (
          <Result step={step} />
        ) : answered?.error ? (
          <span className={styles.statusError}>{t.failed(answered.error)}</span>
        ) : answered ? (
          <RailLoader size="inline" label={t.grading} showLabel />
        ) : decision ? (
          <span className={styles.statusMove}>
            <strong>{t.yourMove}</strong>
            {decision.toCallBb > 0 ? <span>{t.toCall(decision.toCallBb)}</span> : null}
          </span>
        ) : null}
      </StatusRow>

      {decision ? (
        <ActionButtons choices={buttons} groups={groups} picked={answered?.picked ?? null} disabled={Boolean(answered)} onPick={pickGroup} info={info} />
      ) : null}
      {decision ? (
        <div className={styles.afterRow}>
          <div className={styles.clock} data-done={answered ? true : undefined}>
            <TimebankBar left={left} seconds={seconds} />
          </div>
          {graded ? (
            <div className={styles.nextRow}>
              {holding ? (
                <>
                  <span className={styles.muted}>{t.autoNext}</span>
                  <button type="button" className={styles.linkButton} onClick={() => setHolding(false)}>
                    {t.stay}
                  </button>
                </>
              ) : null}
              {waiting ? <RailLoader size="inline" label={t.play.thinking} showLabel /> : null}
              <button type="button" className={styles.next} onClick={proceed} disabled={waiting} aria-keyshortcuts="N Enter">
                {t.play.continue}
                <kbd aria-hidden="true">N</kbd>
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {decision ? (
        <DecisionPanel
          decision={verdict}
          spot={null}
          settings={settings}
          target={step ?? null}
          read={host.playRange ?? null}
          answered={Boolean(graded)}
          study={study}
        />
      ) : null}

      {over ? (
        <div className={styles.after}>
          <div className={styles.nextRow}>
            <button type="button" className={styles.next} onClick={newHand} aria-keyshortcuts="N Enter">
              {t.next}
              <kbd aria-hidden="true">N</kbd>
            </button>
          </div>
          {over.reason === "no-reference" ? <Dismissible className={styles.notice}>{t.play.noReference}</Dismissible> : null}
          {state.approximate ? <p className={styles.muted}>{t.play.approximate}</p> : null}
          {log.length > 0 ? (
            <section className={styles.block} aria-label={t.play.summary}>
              <h3 className={styles.blockHead}>{t.play.summary}</h3>
              <ol className={styles.handLog}>
                {log.map((row, index) => (
                  <li key={index} data-grade={row.decision.grade ?? undefined}>
                    <span className={styles.handLogStreet}>{t.modes[row.street] ?? row.street}</span>
                    <span>{row.label}</span>
                    <span className={styles.handLogGrade}>
                      {row.decision.grade ? `${GLYPH[row.decision.grade]} ${t.words.grades[row.decision.grade]}` : "—"}
                    </span>
                    <span className={styles.optionEv}>{(row.decision.evLoss ?? 0) > 0.005 ? t.evLost(row.decision.evLoss ?? 0) : t.noLoss}</span>
                  </li>
                ))}
              </ol>
              <p className={styles.muted}>{t.play.evLostTotal(lost)}</p>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The hand's result on the felt: who won and what the hero made. */
function Result({ step }: { step: PlayStep }) {
  const { t } = useTrainerHost();
  const over = step.over!;
  const how =
    over.reason === "showdown"
      ? t.play.showdown
      : over.reason === "fold"
        ? over.winner === "hero"
          ? t.play.villainFolded
          : t.play.heroFolded
        : null;
  const net = over.heroNetBb;
  return (
    <div className={styles.verdict} data-result={net > 0 ? "won" : net < 0 ? "lost" : "even"}>
      {how ? <span>{how}</span> : null}
      {over.reason !== "no-reference" ? (
        <strong className={styles.result}>
          {over.winner === "split" ? t.play.split : net > 0 ? t.play.won(net) : net < 0 ? t.play.lost(-net) : t.play.even}
        </strong>
      ) : null}
    </div>
  );
}
