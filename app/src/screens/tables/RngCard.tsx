/**
 * (T5) The RNG: its switch - off and greyed while no room allows it (the
 * Rust side's word: `hud_policy`'s `rng`) -, the colour bands as one bar
 * (a band opens its editor: label, colour, where it ends, split, remove),
 * and when it rolls (a new hand, a click, a timer). The settings can be made
 * ready before a room allows it. Every change is checked as
 * `RngSettings::validate` checks it (`rngProblem`) before it is saved.
 */
import { useState, type CSSProperties } from "react";

import { useT } from "../../i18n";
import type { HudPolicy, RngSettings } from "../../lib/ipc";
import { PopoverButton } from "../hud/popovers";
import { Toggle } from "../settings/Toggle";
import {
  DEFAULT_TIMER_SECS,
  MAX_BANDS,
  MAX_LABEL,
  MAX_TIMER_SECS,
  bandShare,
  bandSpans,
  removeBand,
  rngAllowedAnywhere,
  rngProblem,
  setBandColour,
  setBandEnd,
  setBandLabel,
  setTimer,
  splitBand,
  type BandSpan,
} from "./model";
import styles from "./Tables.module.css";

/** Dark text on a light band, light on a dark one. */
function inkOn(colour: string): string {
  const v = Number.parseInt(colour.slice(1), 16);
  const [r, g, b] = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#0b0f14" : "#ffffff";
}

export function RngCard({
  policy,
  rng,
  onSave,
}: {
  policy: HudPolicy;
  rng: RngSettings;
  onSave: (next: RngSettings) => Promise<boolean>;
}) {
  const s = useT().tables.rng;
  const [problem, setProblem] = useState<string | null>(null);
  const allowed = rngAllowedAnywhere(policy);
  const save = (next: RngSettings) => {
    const found = rngProblem(next);
    if (found !== null) {
      setProblem(s.problem[found]);
      return;
    }
    setProblem(null);
    void onSave(next);
  };
  const timer = rng.triggers.timerSecs ?? null;
  const spans = bandSpans(rng);
  return (
    <section className={styles.card} aria-label={s.label}>
      <div className={styles.line}>
        <span className={styles.cardTitle}>{s.label}</span>
        {!allowed ? (
          <span className={styles.warn} title={s.notAllowedWhy}>
            {s.notAllowed}
          </span>
        ) : null}
        <Toggle label={s.label} checked={allowed && rng.enabled} disabled={!allowed} onChange={(on) => save({ ...rng, enabled: on })} />
      </div>
      <div className={styles.bandBar} role="group" aria-label={s.bands}>
        {spans.map((span, index) => (
          <BandButton key={index} rng={rng} span={span} index={index} onSave={save} />
        ))}
      </div>
      <div className={styles.line}>
        <span className={styles.lineLabel}>{s.roll}</span>
        <button
          type="button"
          className={`chip-btn${rng.triggers.newHand ? " is-active" : ""}`}
          aria-pressed={rng.triggers.newHand}
          onClick={() => save({ ...rng, triggers: { ...rng.triggers, newHand: !rng.triggers.newHand } })}
        >
          {s.newHand}
        </button>
        <button
          type="button"
          className={`chip-btn${rng.triggers.click ? " is-active" : ""}`}
          aria-pressed={rng.triggers.click}
          onClick={() => save({ ...rng, triggers: { ...rng.triggers, click: !rng.triggers.click } })}
        >
          {s.click}
        </button>
        <button
          type="button"
          className={`chip-btn${timer !== null ? " is-active" : ""}`}
          aria-pressed={timer !== null}
          onClick={() => save(setTimer(rng, timer === null ? DEFAULT_TIMER_SECS : null))}
        >
          {s.every(timer ?? DEFAULT_TIMER_SECS)}
        </button>
        {timer !== null ? (
          <NumberField
            key={timer}
            label={s.seconds}
            value={timer}
            min={1}
            max={MAX_TIMER_SECS}
            onCommit={(secs) => save(setTimer(rng, secs))}
          />
        ) : null}
      </div>
      {problem !== null ? <p className={styles.error}>{problem}</p> : null}
    </section>
  );
}

/** A band of the bar; a click opens its editor. */
function BandButton({
  rng,
  span,
  index,
  onSave,
}: {
  rng: RngSettings;
  span: BandSpan;
  index: number;
  onSave: (next: RngSettings) => void;
}) {
  const s = useT().tables.rng;
  const last = index === rng.bands.length - 1;
  const range = s.band(span.from, span.to);
  return (
    <span
      className={styles.bandSlot}
      style={
        {
          flexGrow: Math.max(bandShare(span, rng), 0.0001),
          "--band-colour": span.colour,
          "--band-ink": inkOn(span.colour),
        } as CSSProperties
      }
    >
      <PopoverButton
        label={s.bandMenu(span.from, span.to)}
        content={span.label ?? range}
        title={span.label ? range : undefined}
        className={styles.band}
        align="start"
        popoverClassName={styles.popover}
      >
        {(close) => (
          <div className={styles.form}>
            <label className={styles.field}>
              <span>{s.bandLabel}</span>
              <input
                className={styles.input}
                defaultValue={span.label ?? ""}
                maxLength={MAX_LABEL}
                onBlur={(e) => {
                  if ((e.target.value.trim() || null) !== span.label) onSave(setBandLabel(rng, index, e.target.value));
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
              />
            </label>
            <label className={styles.field}>
              <span>{s.bandColour}</span>
              <input
                type="color"
                className={styles.colour}
                defaultValue={span.colour}
                onBlur={(e) => {
                  if (e.target.value.toLowerCase() !== span.colour.toLowerCase()) onSave(setBandColour(rng, index, e.target.value));
                }}
              />
            </label>
            {!last ? (
              <label className={styles.field}>
                <span>{s.bandEnd}</span>
                <NumberField
                  label={s.bandEnd}
                  value={span.to}
                  min={span.from}
                  max={rng.bands[index + 1].upTo - 1}
                  onCommit={(upTo) => onSave(setBandEnd(rng, index, upTo))}
                />
              </label>
            ) : null}
            <div className={styles.formActions}>
              <button
                type="button"
                className="btn btn--sm"
                disabled={span.to <= span.from || rng.bands.length >= MAX_BANDS}
                onClick={() => {
                  onSave(splitBand(rng, index));
                  close();
                }}
              >
                {s.split}
              </button>
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                disabled={rng.bands.length <= 1}
                onClick={() => {
                  onSave(removeBand(rng, index));
                  close();
                }}
              >
                {s.remove}
              </button>
            </div>
          </div>
        )}
      </PopoverButton>
    </span>
  );
}

/** A whole number, saved on Enter or leaving the field (kept in range). */
export function NumberField({
  label,
  value,
  min,
  max,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onCommit: (value: number) => void;
}) {
  const commit = (text: string) => {
    const n = Math.round(Number(text));
    if (!Number.isFinite(n) || text.trim() === "") return;
    const clamped = Math.min(max, Math.max(min, n));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <input
      type="number"
      className={`${styles.input} ${styles.number}`}
      aria-label={label}
      defaultValue={value}
      min={min}
      max={max}
      step={1}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}
