/**
 * "Play it ▸" from Analytics (docs/ANALYTICS.md Step 9, `played.ts`): one
 * of the player's own decisions on the Trainer's table, dealt once - the
 * seats, the line, the board and the hero's cards as they were - with the
 * analysis' own options as the buttons, graded against them, and the same
 * verdict and why as any spot. The session records it as a whole hand's
 * decision (no deal to repeat); then the drill goes on (`onDone`).
 */

"use client";

import { RailLoader } from "@rail/ui/loader/RailLoader";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DecisionAnalysis, OptionAnalysis } from "../../lib/analysis/types";
import type { TrainerAnswer } from "../../lib/training";
import type { PlayedRef } from "./analytics";
import { ActionButtons, buttonInfo, groupChoices, groupForKey, TimebankBar, useTimebank, type Choice } from "./Decision";
import { DecisionPanel } from "./DecisionPanel";
import { bestIndex, useOptionText, Verdict } from "./Feedback";
import { feltOf } from "./felt";
import { useTrainerHost } from "./host";
import { gradePlayed, playedSpot, type PlayedSpot } from "./played";
import { answerMix, cardsText, handDecisionKey, type SessionAnswer } from "./sessions";
import type { TrainerSettings } from "./settings";
import { ActionStrip, StatusRow } from "./SpotFelt";
import { TableBox, TrainerTable, type HeroMove } from "./TrainerTable";
import styles from "./trainer.module.css";

const tone = (option: OptionAnalysis) => (option.allIn ? "allin" : option.action);

type Loaded = { status: "loading" } | { status: "ready"; spot: PlayedSpot } | { status: "missing" };

export function PlayedPlayer({
  played,
  settings,
  onScored,
  onAnswer,
  onDone,
}: {
  played: PlayedRef;
  settings: TrainerSettings;
  onScored: (answer: TrainerAnswer) => void;
  onAnswer?: (answer: SessionAnswer) => void;
  /** The played spot is over (answered, or not loadable): the drill goes on. */
  onDone: () => void;
}) {
  const host = useTrainerHost();
  const { t } = host;
  const optionText = useOptionText();
  // A host that loads no hands (no account): straight on to the drill's own deals.
  const [loaded, setLoaded] = useState<Loaded>(() => (host.played ? { status: "loading" } : { status: "missing" }));
  const [answered, setAnswered] = useState<{ picked: number; shown: DecisionAnalysis } | null>(null);

  useEffect(() => {
    let live = true;
    if (!host.played) return;
    host
      .played(played.hand)
      .then((hand) => {
        if (!live) return;
        const spot = hand ? playedSpot(hand, played) : null;
        setLoaded(spot ? { status: "ready", spot } : { status: "missing" });
      })
      .catch(() => live && setLoaded({ status: "missing" }));
    return () => {
      live = false;
    };
  }, [host, played]);

  const spot = loaded.status === "ready" ? loaded.spot : null;
  const felt = useMemo(() => (spot ? feltOf(spot.hand, spot.board) : null), [spot]);
  const buttons = useMemo<Choice[]>(
    () =>
      (spot?.decision.options ?? []).map((option) => ({
        label: t.words.option(option.action, option.sizeBb, option.allIn, option.sizePot),
        tone: tone(option),
        alias: option.allIn ? "allin" : option.action === "fold" || option.action === "check" || option.action === "call" ? option.action : null,
      })),
    [spot, t],
  );
  const groups = useMemo(() => groupChoices(buttons, settings.buttons), [buttons, settings.buttons]);

  const pick = useCallback(
    (index: number) => {
      if (!spot || answered) return;
      const { result, shown } = gradePlayed(spot, index);
      setAnswered({ picked: index, shown });
      onScored({ grade: result.grade, evLoss: result.evLoss, evLossPot: result.evLossPot, score: result.score });
      const label = buttons[index]?.label ?? "";
      host.kept?.({ at: new Date().toISOString(), street: spot.street, cards: [...spot.cards], label, grade: result.grade, evLoss: result.evLoss });
      const best = bestIndex(shown);
      onAnswer?.({
        at: new Date().toISOString(),
        street: spot.street,
        cards: cardsText(spot.cards),
        board: cardsText(spot.board),
        spotKey: handDecisionKey(spot.street, shown.facts.position ?? "-", spot.cards, spot.board),
        position: shown.facts.position,
        handClass: shown.facts.handClass,
        move: label.slice(0, 60) || "?",
        best: best !== null ? optionText(shown.options[best]).slice(0, 60) : "",
        grade: result.grade,
        evLoss: result.evLoss,
        score: result.score,
        ref: null,
        ...answerMix(shown),
      });
    },
    [spot, answered, buttons, onScored, onAnswer, host, optionText],
  );

  /** A group of sizes behind one button: the size the reference prefers for the hand. */
  const pickGroup = useCallback(
    (g: number) => {
      const group = groups[g];
      if (!group || !spot) return;
      let best = group[0];
      for (const index of group) if ((spot.decision.options[index]?.freq ?? 0) > (spot.decision.options[best]?.freq ?? 0)) best = index;
      pick(best);
    },
    [groups, spot, pick],
  );

  const seconds = Number(settings.timebank) || 0;
  const timeout = useCallback(() => {
    const check = groups.findIndex((group) => buttons[group[0]]?.tone === "check");
    const fold = groups.findIndex((group) => buttons[group[0]]?.tone === "fold");
    pickGroup(check >= 0 ? check : Math.max(0, fold));
  }, [groups, buttons, pickGroup]);
  const left = useTimebank(seconds, Boolean(spot) && !answered, timeout);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if (document.querySelector("[aria-modal='true']")) return;
      const key = event.key.toLowerCase();
      if (key === "n" || key === "enter") {
        if (!answered && loaded.status !== "missing") return;
        onDone();
        event.preventDefault();
        return;
      }
      if (!spot || answered) return;
      const g = groupForKey(buttons, groups, key);
      if (g >= 0) {
        pickGroup(g);
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [answered, loaded.status, spot, buttons, groups, pickGroup, onDone]);

  const move = useMemo<HeroMove | null>(() => {
    const option = answered ? spot?.decision.options[answered.picked] : undefined;
    if (!option) return null;
    return { action: option.action as HeroMove["action"], toBb: option.sizeBb, allIn: option.allIn };
  }, [spot, answered]);

  const a = t.analytics;
  if (loaded.status === "loading") {
    return (
      <div className={styles.spot}>
        <div className={styles.stripSpace} aria-hidden="true" />
        <TableBox>
          <div className={styles.loading}>
            <RailLoader label={a.playLoading} showLabel centered />
          </div>
        </TableBox>
      </div>
    );
  }
  if (!spot || !felt) {
    return (
      <div className={styles.notice}>
        <p>{a.playMissing}</p>
        <button type="button" className={styles.next} onClick={onDone}>
          {a.playOn}
          <kbd aria-hidden="true">N</kbd>
        </button>
      </div>
    );
  }

  const verdict = answered?.shown ?? null;
  // Every button's frequency, EV and grade once graded (#417): the buttons are the analysis' own options.
  const info = settings.strategy ? buttonInfo(verdict, groups, (index) => index) : null;
  const study = host.study && verdict ? host.study({ hand: spot.full, actionIndex: spot.decision.actionIndex, decision: verdict, study: null }, null) : null;
  return (
    <div className={`${styles.spot} rail-fade`} data-played="">
      <p className={styles.playedHead}>
        <strong>{a.playIt}</strong> <span className={styles.muted}>{a.playNote}</span>
      </p>
      <ActionStrip items={felt.strip} now />
      <TrainerTable hand={spot.hand} board={spot.board} heroCards={spot.cards} move={move} waiting={!answered} />
      <StatusRow>
        {verdict && verdict.grade ? (
          <Verdict decision={verdict} />
        ) : (
          <span className={styles.statusMove}>
            <strong>{t.yourMove}</strong>
            {spot.decision.facts.toCallBb > 0 ? <span>{t.toCall(spot.decision.facts.toCallBb)}</span> : null}
          </span>
        )}
      </StatusRow>
      <ActionButtons choices={buttons} groups={groups} picked={answered?.picked ?? null} disabled={Boolean(answered)} onPick={pickGroup} info={info} />
      <div className={styles.afterRow}>
        <div className={styles.clock} data-done={answered ? true : undefined}>
          <TimebankBar left={left} seconds={seconds} />
        </div>
        {answered ? (
          <div className={styles.nextRow}>
            <button type="button" className={styles.next} onClick={onDone} aria-keyshortcuts="N Enter">
              {a.playOn}
              <kbd aria-hidden="true">N</kbd>
            </button>
          </div>
        ) : null}
      </div>
      <DecisionPanel decision={verdict} spot={null} settings={settings} target={null} read={null} answered={Boolean(answered)} study={study} />
    </div>
  );
}
