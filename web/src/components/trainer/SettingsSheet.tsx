/**
 * A new training session (`sessions.ts`): its name and its settings, one
 * sheet. Every choice is a row of chips (one click, no dropdown to open),
 * only the rows the chosen mode reads, in three groups - the spot, how the
 * training runs, and what an answer shows. The settings are fixed once the
 * session starts; opened from a running session, the sheet starts a new one
 * and says so. Settings another session already trains offer to continue it.
 * A row's longer explanation sits behind an ⓘ beside its label, shown on
 * hover or focus, not as a paragraph under the chips (#423).
 */

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@rail/ui/icon/Icon";
import type { ChartPosition } from "../../lib/charts";
import { DEAL_BIASES, FLOP_FACINGS, PLAY_FAMILIES, RIVER_POTS, RIVER_ROLES, RIVER_SEATS } from "../../lib/training";
import { useTrainerHost } from "./host";
import { defaultName, sameTraining, sessionSettings, type TrainerSession } from "./sessions";
import {
  BUTTONS,
  DEFAULT_SETTINGS,
  HAND_MODES,
  INPUTS,
  PAUSES,
  PLAYS,
  RANGES,
  REPEATS,
  TABLES,
  TIMEBANKS,
  TRAINER_MODES,
  familiesAt,
  flopLinesAt,
  flopSeatsAt,
  seatsAt,
  setFor,
  setsFor,
  type TrainerSettings,
} from "./settings";
import { analyticsAction, sizeLabel } from "./analytics";
import { ANALYTICS } from "../../lib/stats/analytics";
import styles from "./trainer.module.css";

interface ChipsProps<T extends string> {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  /** What the chosen value does, in the ⓘ's hover box beside the label. */
  info?: string;
}

function Chips<T extends string>({ label, value, options, onChange, info }: ChipsProps<T>) {
  return (
    <div className={styles.field} role="radiogroup" aria-label={label}>
      <span className={styles.fieldLabel}>
        {label}
        {info ? (
          <span className={styles.infoTip}>
            <button type="button" className={styles.infoButton} aria-label={info}>
              <Icon name="info" />
            </button>
            <span className={styles.infoBox} role="tooltip">
              {info}
            </span>
          </span>
        ) : null}
      </span>
      <span className={styles.chips}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={option.value === value}
            className={styles.chip}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </span>
    </div>
  );
}

export function SettingsSheet({
  initial,
  from,
  sessions,
  canPlayHands,
  onStart,
  onContinue,
  onClose,
}: {
  initial: TrainerSettings;
  /** Opened from a running session: changing settings starts a new one. */
  from: TrainerSession | null;
  /** The player's sessions, to find one that trains the same settings. */
  sessions: readonly TrainerSession[];
  canPlayHands: boolean;
  onStart: (name: string, settings: TrainerSettings) => void;
  onContinue: (session: TrainerSession) => void;
  onClose: () => void;
}) {
  const { t } = useTrainerHost();
  const panel = useRef<HTMLDivElement>(null);
  const [settings, setSettings] = useState<TrainerSettings>(initial);
  const [custom, setCustom] = useState<string | null>(null);
  useEffect(() => {
    panel.current?.focus();
  }, []);
  const onChange = (patch: Partial<TrainerSettings>) =>
    setSettings((current) => {
      const next = { ...current, ...patch };
      // A whole hand starts preflop or on the flop: a turn or river spot mode becomes the flop.
      if (next.play === "hand" && !HAND_MODES.includes(next.mode)) next.mode = "flop";
      return next;
    });
  const auto = defaultName(settings, t);
  const name = custom ?? auto;
  const twin = useMemo(
    () => sessions.find((session) => !session.archived && session.id !== from?.id && sameTraining(sessionSettings(session), settings)) ?? null,
    [sessions, settings, from],
  );
  const unchanged = from !== null && sameTraining(sessionSettings(from), settings);
  const mode = settings.mode;
  const set = setFor(mode, settings.set);
  const anyOf = <T extends string>(values: readonly T[], names: Record<string, string>) => [
    { value: "any" as const, label: names.any ?? t.any },
    ...values.map((value) => ({ value, label: names[value] ?? value })),
  ];
  const seatChips = (seats: readonly ChartPosition[]) => [
    { value: "" as string, label: t.any },
    ...seats.map((seat) => ({ value: seat as string, label: seat as string })),
  ];
  const postflop = mode === "flop" || mode === "turn" || mode === "river";
  // A whole hand starts from a heads-up line, and on the flop from its root: what is faced is played out.
  const hand = settings.play === "hand";

  const s = t.sessions;
  return (
    <div className={styles.sheetLayer} onKeyDown={(event) => event.key === "Escape" && onClose()}>
      <button type="button" className={styles.scrim} aria-label={t.close} onClick={onClose} />
      <div ref={panel} className={styles.sheet} role="dialog" aria-modal="true" aria-label={s.title} tabIndex={-1}>
        <div className={styles.sheetHead}>
          <strong>{s.title}</strong>
          <span className={styles.sheetActions}>
            <button type="button" className={styles.linkButton} onClick={() => onChange({ ...DEFAULT_SETTINGS, mode: settings.mode, play: settings.play })}>
              {t.reset}
            </button>
            <button type="button" className={styles.linkButton} onClick={onClose}>
              {t.close}
            </button>
          </span>
        </div>

        {from ? <p className={styles.sheetNote}>{s.changeNote(from.name, from.hands)}</p> : null}

        <form
          className={styles.nameForm}
          onSubmit={(event) => {
            event.preventDefault();
            if (!unchanged && name.trim()) onStart(name.trim(), settings);
          }}
        >
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{s.name}</span>
            <span className={styles.nameRow}>
              <input
                className={`${styles.input} ${styles.nameInput}`}
                value={name}
                maxLength={60}
                onChange={(event) => setCustom(event.target.value)}
              />
              {custom !== null ? (
                <button type="button" className={styles.linkButton} onClick={() => setCustom(null)}>
                  {s.auto}
                </button>
              ) : null}
            </span>
            <span className={styles.muted}>{custom !== null ? s.nameOwn : s.nameAuto}</span>
          </label>
          {twin ? (
            <div className={styles.twin}>
              <span>
                {s.duplicate(twin.name)}
                <span className={styles.muted}> · {s.duplicateMeta(twin.hands, twin.hands ? Math.round(twin.scoreSum / twin.hands).toString() : "—")}</span>
              </span>
              <button type="button" className={styles.next} onClick={() => onContinue(twin)}>
                {s.continueIt}
              </button>
            </div>
          ) : null}
          <div className={styles.startRow}>
            <button type="button" className={styles.linkButton} onClick={onClose}>
              {s.cancel}
            </button>
            <button type="submit" className={twin ? styles.chip : styles.next} disabled={unchanged || !name.trim()}>
              {twin ? s.startAnyway : s.start}
            </button>
          </div>
        </form>

        <section className={styles.sheetSection}>
          <Chips
            label={t.modesLabel}
            value={settings.mode}
            options={TRAINER_MODES.filter((id) => settings.play !== "hand" || HAND_MODES.includes(id)).map((id) => ({ value: id, label: t.modes[id] ?? id }))}
            onChange={(value) => onChange({ mode: value })}
          />
          {canPlayHands ? (
            <Chips label={t.play.label} value={settings.play} options={PLAYS.map((value) => ({ value, label: t.play[value] }))} onChange={(play) => onChange({ play })} />
          ) : null}
        </section>

        {mode !== "focus" ? (
          <section className={styles.sheetSection}>
            <h3>{t.sections.spot}</h3>
            <Chips
              label={t.table}
              value={set}
              options={setsFor(mode).map((spec) => ({ value: spec.id, label: t.tableValue(spec.players, spec.stackBb, Boolean(spec.straddle), Boolean(spec.ante)) }))}
              onChange={(value) => onChange({ set: value, line: null })}
            />
            {mode === "preflop" ? (
              <>
                <Chips
                  label={t.family}
                  value={settings.family}
                  options={[
                    { value: "random", label: t.families.random },
                    ...familiesAt(set)
                      .filter((f) => !hand || PLAY_FAMILIES.includes(f))
                      .map((f) => ({ value: f, label: t.families[f] ?? f })),
                  ]}
                  onChange={(family) => onChange(family === "rfi" ? { family, vs: null } : { family })}
                />
                <Chips
                  label={t.hero}
                  value={settings.seat ?? ""}
                  options={seatChips(seatsAt(set))}
                  onChange={(seat) => onChange({ seat: (seat || null) as ChartPosition | null })}
                />
                {settings.family !== "rfi" ? (
                  <Chips
                    label={t.vs}
                    value={settings.vs ?? ""}
                    options={seatChips(seatsAt(set))}
                    onChange={(vs) => onChange({ vs: (vs || null) as ChartPosition | null })}
                  />
                ) : null}
              </>
            ) : null}
            {postflop ? (
              <>
                <Chips label={t.pot} value={settings.pot} options={anyOf(RIVER_POTS, t.pots)} onChange={(pot) => onChange({ pot })} />
                <Chips label={t.side} value={settings.side} options={anyOf(RIVER_SEATS, t.sides)} onChange={(side) => onChange({ side })} />
                <Chips label={t.role} value={settings.role} options={anyOf(RIVER_ROLES, t.roles)} onChange={(role) => onChange({ role })} />
                {hand && mode === "flop" ? null : (
                <Chips
                  label={t.facing}
                  value={mode !== "flop" && settings.facing === "raise" ? "any" : settings.facing}
                  options={anyOf(mode === "flop" ? FLOP_FACINGS : (["check", "bet"] as const), t.facings)}
                  onChange={(facing) => onChange({ facing })}
                />
                )}
                {!hand && (settings.facing === "bet" || settings.facing === "raise" || settings.size !== null) ? (
                  <Chips
                    label={t.analytics.size}
                    value={settings.size ?? ""}
                    options={[{ value: "", label: t.any }, ...ANALYTICS.file.sizeBuckets.map((bucket) => ({ value: bucket.id, label: sizeLabel(bucket.id, t) }))]}
                    onChange={(size) => onChange({ size: size || null })}
                  />
                ) : null}
              </>
            ) : null}
            {mode === "flop" ? (
              <>
                <Chips
                  label={t.hero}
                  value={settings.seat && flopSeatsAt(set).includes(settings.seat) ? settings.seat : ""}
                  options={seatChips(flopSeatsAt(set))}
                  onChange={(seat) => onChange({ seat: (seat || null) as ChartPosition | null })}
                />
                <Chips
                  label={t.line}
                  value={settings.line ?? ""}
                  options={[{ value: "", label: t.any }, ...flopLinesAt(set).map((line) => ({ value: line.id, label: t.words.lineName(line.id) }))]}
                  onChange={(line) => onChange({ line: line || null })}
                />
              </>
            ) : null}
          </section>
        ) : null}

        <section className={styles.sheetSection}>
          <h3>{t.sections.play}</h3>
          <Chips
            label={s.repeatLabel}
            value={settings.repeat}
            options={REPEATS.map((value) => ({ value, label: s.repeats[value] ?? value }))}
            onChange={(repeat) => onChange({ repeat })}
            info={settings.play === "spot" ? s.repeatHints[settings.repeat] : undefined}
          />
          <Chips
            label={t.deal}
            value={postflop && !hand && settings.classes.length > 0 ? "classes" : settings.deal}
            options={[
              ...DEAL_BIASES.map((value) => ({ value: value as string, label: t.deals[value] ?? value })),
              // Analytics' classes (Step 9): offered while the sheet was opened with them.
              ...(postflop && !hand && initial.classes.length > 0 ? [{ value: "classes", label: t.analytics.hands(analyticsAction(initial)) }] : []),
            ]}
            onChange={(deal) =>
              onChange(deal === "classes" ? { classes: [...initial.classes] } : { deal: deal as TrainerSettings["deal"], classes: [] })
            }
          />
          {!hand ? (
            <Chips
              label={t.inputLabel}
              value={settings.input}
              options={INPUTS.map((value) => ({ value, label: t.inputs[value] ?? value }))}
              onChange={(input) => onChange({ input })}
            />
          ) : null}
          <Chips
            label={t.buttonsLabel}
            value={settings.buttons}
            options={BUTTONS.map((value) => ({ value, label: t.buttonsValues[value] ?? value }))}
            onChange={(buttons) => onChange({ buttons })}
          />
          <Chips
            label={t.timebankLabel}
            value={settings.timebank}
            options={TIMEBANKS.map((value) => ({ value, label: t.timebanks[value] ?? value }))}
            onChange={(timebank) => onChange({ timebank })}
          />
          {!hand ? (
            <>
              <Chips
                label={t.tablesLabel}
                value={settings.tables}
                options={TABLES.map((value) => ({ value, label: value }))}
                onChange={(tables) => onChange({ tables })}
              />
              {settings.tables !== "1" ? <p className={styles.muted}>{t.tablesNote}</p> : null}
            </>
          ) : null}
          <Chips
            label={t.pause}
            value={settings.pause}
            options={PAUSES.map((value) => ({ value, label: t.pauses[value] ?? value }))}
            onChange={(pause) => onChange({ pause })}
          />
        </section>

        <section className={styles.sheetSection}>
          <h3>{t.sections.show}</h3>
          <Chips
            label={t.rangePanel}
            value={settings.range}
            options={RANGES.map((value) => ({ value, label: t.ranges[value] ?? value }))}
            onChange={(range) => onChange({ range })}
          />
          <Chips
            label={t.strategy}
            value={settings.strategy ? "on" : "off"}
            options={[
              { value: "on", label: t.on },
              { value: "off", label: t.off },
            ]}
            onChange={(value) => onChange({ strategy: value === "on" })}
          />
        </section>
      </div>
    </div>
  );
}
