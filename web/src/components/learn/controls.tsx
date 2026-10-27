/**
 * The small controls every concept widget is built from: a labelled slider, a
 * labelled result, a share bar, and the locale's number formats.
 *
 * Sliders are native `<input type="range">`: keyboard, touch and screen
 * readers come for free, and `aria-valuetext` reads the formatted value
 * ("27.3%", "7.5 bb") rather than the raw number.
 */

"use client";

import { useId, type ReactNode } from "react";
import { useDict } from "../../lib/i18n/client";
import { numberFormat, useIntlLocale } from "../stats/format";
import styles from "./learn.module.css";

export interface Formats {
  /** A share as a percentage, one decimal when it is not whole: "27.3%". */
  pct: (value: number) => string;
  /** Big blinds, up to two decimals: "7.5 bb". */
  bb: (value: number) => string;
  /** A bare number, up to `digits` decimals. */
  num: (value: number, digits?: number) => string;
  /** Signed big blinds: "+0.56 bb", "−1.3 bb". */
  signedBb: (value: number) => string;
}

export function useFormats(): Formats {
  const locale = useIntlLocale();
  const t = useDict().learn.widgets;
  return {
    pct: (value) => numberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(value),
    bb: (value) => t.bb(numberFormat(locale, { maximumFractionDigits: 2 }).format(value)),
    num: (value, digits = 2) => numberFormat(locale, { maximumFractionDigits: digits }).format(value),
    signedBb: (value) =>
      t.bb(numberFormat(locale, { maximumFractionDigits: 2, signDisplay: "exceptZero" }).format(Math.abs(value) < 0.005 ? 0 : value)),
  };
}

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  format: (value: number) => string;
  hint?: string;
}

export function Slider({ label, value, min, max, step, onChange, format, hint }: SliderProps) {
  const id = useId();
  const shown = format(value);
  return (
    <div className={styles.slider}>
      <div className={styles.sliderHead}>
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id} className={styles.sliderValue}>
          {shown}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={shown}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {hint ? (
        <p id={`${id}-hint`} className={styles.hint}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export type Tone = "good" | "bad" | "neutral";

/** One computed number with its label. `lead` makes it the first thing the eye lands on. */
export function Stat({ label, value, tone = "neutral", lead = false, note }: { label: string; value: string; tone?: Tone; lead?: boolean; note?: ReactNode }) {
  return (
    <div className={`${styles.stat} ${lead ? styles.statLead : ""}`}>
      <dt>{label}</dt>
      <dd className={tone === "good" ? styles.toneGood : tone === "bad" ? styles.toneBad : undefined}>
        {value}
        {note ? <span className={styles.statNote}>{note}</span> : null}
      </dd>
    </div>
  );
}

export function Stats({ children }: { children: ReactNode }) {
  return (
    <dl className={styles.stats} aria-live="polite">
      {children}
    </dl>
  );
}

/**
 * A 0–1 share as a bar, with an optional marker (a threshold: the price, the
 * indifference point). Decorative: the same numbers are always in text beside it.
 */
export function ShareBar({ value, marker, tone = "neutral" }: { value: number; marker?: number; tone?: Tone }) {
  const clamp = (x: number) => `${Math.max(0, Math.min(1, x)) * 100}%`;
  return (
    <div className={styles.bar} aria-hidden="true">
      <span
        className={`${styles.barFill} ${tone === "good" ? styles.barGood : tone === "bad" ? styles.barBad : ""}`}
        style={{ inlineSize: clamp(value) }}
      />
      {marker !== undefined ? <span className={styles.barMarker} style={{ insetInlineStart: clamp(marker) }} /> : null}
    </div>
  );
}

/** EV's tone and word: profitable, losing, or break-even within half a hundredth. */
export function evTone(value: number): Tone {
  return value > 0.005 ? "good" : value < -0.005 ? "bad" : "neutral";
}
