/**
 * One table of the Trainer's spot mode: a spot dealt for the request, the
 * felt, the answer (a button, a grouped button or a mix), the clock, the
 * range panel, the grade and the feedback; then the next spot. Several of
 * these side by side are the multi-table mode (T5): each deals and grades
 * on its own, and only the table the Trainer names takes the keys.
 *
 * Every async step is keyed by the component itself (`OneSpot` mounts once
 * per spot): a slow deal or grade for an old spot never lands on a new one.
 */

"use client";

import { RailLoader } from "@rail/ui/loader/RailLoader";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { DecisionAnalysis, OptionAnalysis } from "../../lib/analysis/types";
import { nextSeed, STREAK_GRADES, type GradedAnswer, type TrainerAnswer, type TrainerSpot } from "../../lib/training";
import { gradeMix, normalised, type MixResult } from "../../lib/training/frequency";
import type { RangeView } from "../../lib/training/rangeView";
import { ActionButtons, groupChoices, groupForKey, MixInput, TimebankBar, useTimebank, type Choice } from "./Decision";
import { feltOf } from "./felt";
import { Feedback, Verdict } from "./Feedback";
import { useTrainerHost } from "./host";
import { RangeGrid } from "./RangeGrid";
import type { SpotRequest, StreetMode, TrainerSettings } from "./settings";
import { ActionStrip, SpotFelt } from "./SpotFelt";
import styles from "./trainer.module.css";

const DEAL_TRIES = 3;
const AUTO_NEXT_MS = 1600;

export type TableStatus = "dealing" | "waiting" | "answered";

export interface SpotPlayerProps {
  request: SpotRequest;
  mode: StreetMode;
  settings: TrainerSettings;
  /** Which keys this table takes: the answer keys, the next-spot keys, or none (another table has them). */
  keys: "answer" | "next" | null;
  /** A small table among several: the feedback folds under it. */
  compact?: boolean;
  onScored: (answer: TrainerAnswer) => void;
  onStatus?: (status: TableStatus) => void;
}

/** Spots one after another: each its own component, so a new spot starts from a clean state. */
export function SpotPlayer(props: SpotPlayerProps) {
  const [round, setRound] = useState(0);
  const next = useCallback(() => setRound((value) => value + 1), []);
  return <OneSpot key={`${JSON.stringify(props.request)}|${round}`} {...props} next={next} />;
}

/** The menu index an analysis option is (same action, same size). */
function menuIndexOf(spot: TrainerSpot, option: OptionAnalysis): number {
  if (spot.kind === "preflop") {
    return spot.menu.findIndex((item) =>
      option.allIn ? item.action === "allin" : item.action === option.action && (option.sizeBb === undefined || Math.abs(item.toBb - option.sizeBb) < 0.01),
    );
  }
  return spot.menu.findIndex((item) =>
    option.allIn ? item.kind === "allin" : item.kind === option.action && (option.sizeBb === undefined || Math.abs(item.to - option.sizeBb) < 0.01),
  );
}

interface Answered {
  picked: number;
  graded: GradedAnswer | null;
  /** A mix answer: the shares given, per analysis option, and how it scored. */
  mix: { shares: number[]; result: MixResult } | null;
  error: string | null;
  timedOut: boolean;
}

function OneSpot({ request, mode, settings, keys, compact = false, onScored, onStatus, next }: SpotPlayerProps & { next: () => void }) {
  const host = useTrainerHost();
  const { t } = host;
  const [spot, setSpot] = useState<TrainerSpot | null>(null);
  const [dealt, setDealt] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answered, setAnswered] = useState<Answered | null>(null);
  const [holding, setHolding] = useState(false);
  const [range, setRange] = useState<{ view: RangeView | null } | null>(null);
  const [open, setOpen] = useState(!compact);
  const requestJson = JSON.stringify(request);

  // The spot, dealt once.
  useEffect(() => {
    let live = true;
    const parsed = JSON.parse(requestJson) as SpotRequest;
    (async () => {
      for (let attempt = 0; attempt < DEAL_TRIES; attempt += 1) {
        const got = await host.deal(parsed, nextSeed());
        if (got) return got;
      }
      return null;
    })()
      .then((got) => {
        if (!live) return;
        setSpot(got);
        setDealt(true);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setError(e instanceof Error ? e.message : String(e));
        setDealt(true);
      });
    return () => {
      live = false;
    };
  }, [requestJson, host]);

  // The range panel, read once the spot is there (when asked for).
  const wantsRange = settings.range !== "off" && Boolean(host.range);
  useEffect(() => {
    if (!spot || !wantsRange || !host.range) return;
    let live = true;
    host
      .range(spot)
      .then((view) => live && setRange({ view }))
      .catch(() => live && setRange({ view: null }));
    return () => {
      live = false;
    };
  }, [spot, wantsRange, host]);

  const status: TableStatus = !dealt ? "dealing" : answered || !spot ? "answered" : "waiting";
  useEffect(() => {
    onStatus?.(status);
  }, [status, onStatus]);

  const felt = useMemo(() => (spot ? feltOf(spot.hand, spot.kind === "preflop" ? [] : spot.board) : null), [spot]);
  const choices = useMemo<Choice[]>(() => {
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
  const groups = useMemo(() => groupChoices(choices, settings.buttons), [choices, settings.buttons]);

  const settle = useCallback(
    (result: GradedAnswer, scored: TrainerAnswer, d: DecisionAnalysis, label: string) => {
      onScored(scored);
      if (spot) {
        host.record?.(spot, scored, d.facts.handClass);
        host.kept?.({ at: new Date().toISOString(), street: d.street, cards: [...spot.cards], label, grade: scored.grade, evLoss: scored.evLoss });
      }
      if (settings.pause === "mistakes" && STREAK_GRADES.includes(scored.grade)) setHolding(true);
      void result;
    },
    [onScored, spot, host, settings.pause],
  );

  /** An action answer: a group's first size, then (one per action) the size the reference prefers for the hand. */
  const pickGroup = useCallback(
    (g: number, timedOut = false) => {
      if (!spot || answered) return;
      const group = groups[g];
      if (!group) return;
      setAnswered({ picked: group[0], graded: null, mix: null, error: null, timedOut });
      (async () => {
        let result = await host.grade(spot, group[0]);
        let picked = group[0];
        if (group.length > 1 && result.decision) {
          const options = result.decision.options;
          let best = picked;
          let bestFreq = -1;
          for (const index of group) {
            const option = options.find((o) => menuIndexOf(spot, o) === index);
            if (option && option.freq > bestFreq) {
              bestFreq = option.freq;
              best = index;
            }
          }
          if (best !== picked) {
            picked = best;
            result = await host.grade(spot, best);
          }
        }
        return { result, picked };
      })()
        .then(({ result, picked }) => {
          setAnswered((prev) => (prev ? { ...prev, picked, graded: result } : prev));
          const d = result.decision;
          if (!d || d.grade === null) return;
          settle(result, { grade: d.grade, evLoss: d.evLoss ?? 0, evLossPot: d.evLossPot ?? 0, score: d.score ?? 0 }, d, choices[picked]?.label ?? "");
        })
        .catch((e: unknown) => setAnswered((prev) => (prev ? { ...prev, error: e instanceof Error ? e.message : String(e) } : prev)));
    },
    [spot, answered, groups, host, settle, choices],
  );

  /** A mix answer: graded on the reference's mix for the hand (read from the analysis of its most-taken action). */
  const pickMix = useCallback(
    (shares: number[]) => {
      if (!spot || answered) return;
      const mix = normalised(shares);
      const top = mix.indexOf(Math.max(...mix));
      setAnswered({ picked: top, graded: null, mix: null, error: null, timedOut: false });
      host
        .grade(spot, top)
        .then((result) => {
          const d = result.decision;
          if (!d || d.grade === null) {
            setAnswered((prev) => (prev ? { ...prev, graded: result } : prev));
            return;
          }
          // The shares per analysis option (the menu's order may differ).
          const byOption = d.options.map((option) => {
            const index = menuIndexOf(spot, option);
            return index >= 0 ? (mix[index] ?? 0) : 0;
          });
          const scored = gradeMix(byOption, d.options);
          setAnswered((prev) => (prev ? { ...prev, graded: result, mix: { shares: byOption, result: scored } } : prev));
          const pot = d.facts.potBb > 0 ? d.facts.potBb : 1;
          settle(result, { grade: scored.grade, evLoss: scored.evLoss, evLossPot: scored.evLoss / pot, score: scored.score }, d, t.mixAccuracy(scored.accuracy));
        })
        .catch((e: unknown) => setAnswered((prev) => (prev ? { ...prev, error: e instanceof Error ? e.message : String(e) } : prev)));
    },
    [spot, answered, host, settle, t],
  );

  // The clock: out of time, a check where there is one, else a fold.
  const seconds = Number(settings.timebank) || 0;
  const timeout = useCallback(() => {
    const fallback = groups.findIndex((group) => choices[group[0]]?.tone === "check");
    const fold = groups.findIndex((group) => choices[group[0]]?.tone === "fold");
    pickGroup(fallback >= 0 ? fallback : Math.max(0, fold), true);
  }, [groups, choices, pickGroup]);
  const left = useTimebank(seconds, Boolean(spot) && !answered && settings.input === "action", timeout);

  // A right answer moves on by itself when the trainer waits only after mistakes.
  useEffect(() => {
    if (!holding) return;
    const timer = window.setTimeout(next, AUTO_NEXT_MS);
    return () => window.clearTimeout(timer);
  }, [holding, next]);

  const graded = answered?.graded ?? null;
  const decision = graded?.decision ?? null;

  useEffect(() => {
    if (!keys) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if (document.querySelector("[aria-modal='true']")) return;
      const key = event.key.toLowerCase();
      if (keys === "next") {
        if ((key === "n" || key === "enter") && (graded || answered?.error || (dealt && !spot))) {
          next();
          event.preventDefault();
        }
        return;
      }
      if (!spot || answered || settings.input !== "action") return;
      const g = groupForKey(choices, groups, key);
      if (g >= 0) {
        pickGroup(g);
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keys, graded, answered, dealt, spot, settings.input, choices, groups, pickGroup, next]);

  if (error) {
    return (
      <div className={styles.notice}>
        <p>{t.failed(error)}</p>
        <button type="button" className={styles.linkButton} onClick={next}>
          {t.retry}
        </button>
      </div>
    );
  }
  if (!dealt) {
    return (
      <div className={styles.loading} data-compact={compact || undefined}>
        <RailLoader label={mode === "flop" ? t.loadingFlop : mode === "turn" || mode === "river" ? t.solving : t.dealing} showLabel centered />
      </div>
    );
  }
  if (!spot || !felt) {
    return (
      <div className={styles.notice}>
        <p>{t.noSpot}</p>
        <button type="button" className={styles.linkButton} onClick={next}>
          {t.retry}
        </button>
      </div>
    );
  }

  const mix = answered?.mix ?? null;
  return (
    <div className={`${styles.spot} rail-fade`} data-compact={compact || undefined} data-keys={keys ?? undefined}>
      {compact ? null : <ActionStrip items={felt.strip} />}
      <SpotFelt
        felt={felt}
        cards={spot.cards}
        toCallBb={answered ? 0 : spot.toCallBb}
        compact={compact}
        overlay={
          decision && decision.grade ? (
            <Verdict decision={mix ? { ...decision, grade: mix.result.grade, evLoss: mix.result.evLoss } : decision} note={mix ? t.mixAccuracy(mix.result.accuracy) : answered?.timedOut ? t.timeUp : null}
              compact={compact}
            />
          ) : null
        }
      />
      {settings.input === "frequency" ? (
        <MixInput choices={choices} disabled={Boolean(answered)} onSubmit={pickMix} />
      ) : (
        <ActionButtons choices={choices} groups={groups} picked={answered?.picked ?? null} disabled={Boolean(answered)} onPick={(g) => pickGroup(g)} />
      )}
      {!answered ? <TimebankBar left={left} seconds={seconds} /> : null}

      {wantsRange && !compact ? (
        <section className={styles.block} aria-label={t.rangeHeading}>
          <h3 className={styles.blockHead}>{t.rangeHeading}</h3>
          {range === null ? (
            <RailLoader size="inline" label={t.rangeLoading} showLabel />
          ) : range.view ? (
            <RangeGrid view={range.view} strategy={settings.range === "strategy" || Boolean(answered)} />
          ) : (
            <p className={styles.muted}>{t.rangeNone}</p>
          )}
        </section>
      ) : null}

      {answered && !graded && !answered.error ? (
        <p className={styles.status}>
          <RailLoader size="inline" label={t.grading} showLabel />
        </p>
      ) : null}
      {answered?.error ? <p className={styles.notice}>{t.failed(answered.error)}</p> : null}

      {graded ? (
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
            {compact ? (
              <button type="button" className={styles.linkButton} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
                {t.whyHeading}
              </button>
            ) : null}
            <button type="button" className={styles.next} onClick={next} aria-keyshortcuts={keys === "next" ? "N Enter" : undefined}>
              {t.next}
              {keys === "next" ? <kbd aria-hidden="true">N</kbd> : null}
            </button>
          </div>
          {decision && open ? <Feedback decision={decision} spot={spot} settings={settings} mix={mix?.shares ?? null} /> : null}
          {host.study && open && decision ? host.study(graded, spot) : null}
        </div>
      ) : null}
    </div>
  );
}
