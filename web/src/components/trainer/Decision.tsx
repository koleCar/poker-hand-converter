/**
 * What a decision looks like, the same for one spot and for a whole hand:
 * the answer buttons (every size, or one per action, T5), the clock
 * (the timebank, T5) and the mix input (answering with frequencies, T5).
 */

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTrainerHost } from "./host";
import type { Buttons } from "./settings";
import styles from "./trainer.module.css";

export interface Choice {
  label: string;
  /** fold, check, call, bet, raise, allin: the colour. */
  tone: string;
  alias: "fold" | "check" | "call" | "allin" | null;
}

/** The buttons as groups of menu indices: one each, or the sizes of a bet or a raise as one. */
export function groupChoices(choices: readonly Choice[], buttons: Buttons): number[][] {
  if (buttons === "all") return choices.map((_, i) => [i]);
  const groups: number[][] = [];
  const at = new Map<string, number>();
  choices.forEach((choice, i) => {
    const kind = choice.tone === "bet" || choice.tone === "raise" ? choice.tone : null;
    if (kind && at.has(kind)) groups[at.get(kind)!].push(i);
    else {
      if (kind) at.set(kind, groups.length);
      groups.push([i]);
    }
  });
  return groups;
}

const LETTER: Record<string, string> = { fold: "F", check: "C", call: "C", allin: "A" };

/** The keys a group answers to: its number, and the letter of a fold, check, call or all-in. */
export function groupKeys(choices: readonly Choice[], group: readonly number[], position: number): string[] {
  const alias = group.length === 1 ? choices[group[0]].alias : null;
  return [String(position + 1), alias ? LETTER[alias] : null].filter(Boolean) as string[];
}

/** The group a key picks, or -1. */
export function groupForKey(choices: readonly Choice[], groups: readonly number[][], key: string): number {
  const digit = Number.parseInt(key, 10);
  if (digit >= 1 && digit <= groups.length) return digit - 1;
  const wanted = key === "f" ? ["fold"] : key === "c" || key === "x" ? ["check", "call"] : key === "a" ? ["allin"] : [];
  return groups.findIndex((group) => group.length === 1 && choices[group[0]].alias !== null && wanted.includes(choices[group[0]].alias!));
}

export function ActionButtons({
  choices,
  groups,
  picked,
  disabled,
  onPick,
}: {
  choices: readonly Choice[];
  groups: readonly number[][];
  /** The menu index answered, once it is. */
  picked: number | null;
  disabled: boolean;
  onPick: (group: number) => void;
}) {
  const { t } = useTrainerHost();
  return (
    <div className={styles.buttons} role="group" aria-label={t.yourMove}>
      {groups.map((group, g) => {
        const first = choices[group[0]];
        const keys = groupKeys(choices, group, g);
        const label = group.length > 1 ? (first.tone === "raise" ? t.simpleRaise : t.simpleBet) : first.label;
        return (
          <button
            key={g}
            type="button"
            className={styles.action}
            data-action={first.tone}
            data-picked={picked !== null && group.includes(picked) ? true : undefined}
            disabled={disabled}
            aria-keyshortcuts={keys.join(" ")}
            onClick={() => onPick(g)}
          >
            <span>{label}</span>
            <kbd aria-hidden="true">{keys[0]}</kbd>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The timebank: seconds left while `running`, and `onTimeout` once at zero.
 * `seconds` 0 is no clock.
 */
export function useTimebank(seconds: number, running: boolean, onTimeout: () => void): number | null {
  const [left, setLeft] = useState<number | null>(seconds > 0 ? seconds : null);
  const fired = useRef(false);
  const timeout = useRef(onTimeout);
  useEffect(() => {
    timeout.current = onTimeout;
  }, [onTimeout]);
  useEffect(() => {
    if (!(seconds > 0) || !running) return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      const rest = Math.max(0, seconds - (Date.now() - started) / 1000);
      setLeft(rest);
      if (rest <= 0 && !fired.current) {
        fired.current = true;
        window.clearInterval(timer);
        timeout.current();
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, [seconds, running]);
  return seconds > 0 ? left : null;
}

export function TimebankBar({ left, seconds }: { left: number | null; seconds: number }) {
  const { t } = useTrainerHost();
  if (left === null || !(seconds > 0)) return null;
  const share = Math.max(0, Math.min(1, left / seconds));
  return (
    <div className={styles.timebank} data-low={share < 0.3 || undefined} role="timer" aria-label={left > 0 ? t.timeLeft(Math.ceil(left)) : t.timeUp}>
      <span className={styles.timebankFill} style={{ inlineSize: `${share * 100}%` }} />
      <span className={styles.timebankText}>{left > 0 ? t.timeLeft(Math.ceil(left)) : t.timeUp}</span>
    </div>
  );
}

/** Answering with a mix: a slider per action, in steps of 5%, the total kept in view. */
export function MixInput({ choices, disabled, onSubmit }: { choices: readonly Choice[]; disabled: boolean; onSubmit: (shares: number[]) => void }) {
  const { t, locale } = useTrainerHost();
  const [shares, setShares] = useState<number[]>(() => choices.map(() => 0));
  const total = useMemo(() => shares.reduce((a, b) => a + b, 0), [shares]);
  return (
    <div className={styles.mix}>
      <p className={styles.muted}>{t.mixHint}</p>
      {choices.map((choice, i) => (
        <label key={i} className={styles.mixRow} data-action={choice.tone}>
          <span className={styles.mixLabel}>{choice.label}</span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={shares[i] ?? 0}
            disabled={disabled}
            onChange={(event) => {
              const value = Number(event.target.value);
              setShares((current) => current.map((s, k) => (k === i ? value : s)));
            }}
          />
          <span className={styles.mixValue}>{(shares[i] ?? 0).toLocaleString(locale)}%</span>
        </label>
      ))}
      <div className={styles.mixFoot}>
        <span className={styles.muted} data-off={total !== 100 || undefined}>
          {total.toLocaleString(locale)}%
        </span>
        <button type="button" className={styles.next} disabled={disabled || total <= 0} onClick={() => onSubmit(shares)}>
          {t.mixSubmit}
        </button>
      </div>
    </div>
  );
}
