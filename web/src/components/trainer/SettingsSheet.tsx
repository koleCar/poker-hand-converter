/**
 * The Trainer's settings, one sheet: every choice a row of chips (one click,
 * no dropdown to open), only the rows the current mode reads, in three
 * groups - the spot, how the training runs, and what an answer shows. A
 * change applies at once and deals the next hand under it.
 */

"use client";

import { useEffect, useRef, useState } from "react";
import type { ChartPosition } from "../../lib/charts";
import { DEAL_BIASES, FLOP_FACINGS, PLAY_FAMILIES, RIVER_POTS, RIVER_ROLES, RIVER_SEATS } from "../../lib/training";
import { useTrainerHost } from "./host";
import {
  BUTTONS,
  DEFAULT_SETTINGS,
  INPUTS,
  PAUSES,
  PLAYS,
  RANGES,
  TABLES,
  TIMEBANKS,
  familiesAt,
  flopLinesAt,
  flopSeatsAt,
  seatsAt,
  setFor,
  setsFor,
  type TrainerSettings,
} from "./settings";
import { drillSettings, readDrills, saveDrills, withDrill, type Drill } from "./drills";
import styles from "./trainer.module.css";

interface ChipsProps<T extends string> {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
}

function Chips<T extends string>({ label, value, options, onChange }: ChipsProps<T>) {
  return (
    <div className={styles.field} role="radiogroup" aria-label={label}>
      <span className={styles.fieldLabel}>{label}</span>
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
  open,
  settings,
  onChange,
  onClose,
}: {
  open: boolean;
  settings: TrainerSettings;
  onChange: (patch: Partial<TrainerSettings>) => void;
  onClose: () => void;
}) {
  const { t } = useTrainerHost();
  const panel = useRef<HTMLDivElement>(null);
  const [drills, setDrills] = useState<Drill[]>(() => (typeof window === "undefined" ? [] : readDrills()));
  const [name, setName] = useState("");
  const keep = (list: Drill[]) => {
    setDrills(list);
    saveDrills(list);
  };
  useEffect(() => {
    if (open) panel.current?.focus();
  }, [open]);
  if (!open) return null;

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

  return (
    <div className={styles.sheetLayer} onKeyDown={(event) => event.key === "Escape" && onClose()}>
      <button type="button" className={styles.scrim} aria-label={t.close} onClick={onClose} />
      <div ref={panel} className={styles.sheet} role="dialog" aria-modal="true" aria-label={t.settingsTitle} tabIndex={-1}>
        <div className={styles.sheetHead}>
          <strong>{t.settingsTitle}</strong>
          <span className={styles.sheetActions}>
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => onChange({ ...DEFAULT_SETTINGS, mode: settings.mode })}
            >
              {t.reset}
            </button>
            <button type="button" className={styles.linkButton} onClick={onClose}>
              {t.close}
            </button>
          </span>
        </div>

        <section className={styles.sheetSection}>
          <h3>{t.drills.heading}</h3>
          {drills.length === 0 ? <p className={styles.muted}>{t.drills.none}</p> : null}
          <ul className={styles.drills}>
            {drills.map((drill) => (
              <li key={drill.id}>
                <button type="button" className={styles.chip} aria-label={t.drills.open(drill.name)} onClick={() => onChange(drillSettings(drill))}>
                  {drill.name}
                </button>
                <button type="button" className={styles.linkButton} aria-label={t.drills.remove(drill.name)} onClick={() => keep(drills.filter((d) => d.id !== drill.id))}>
                  ×
                </button>
              </li>
            ))}
          </ul>
          <form
            className={styles.drillForm}
            onSubmit={(event) => {
              event.preventDefault();
              if (!name.trim()) return;
              keep(withDrill(drills, name, settings, `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`));
              setName("");
            }}
          >
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{t.drills.name}</span>
              <input className={styles.input} value={name} maxLength={60} placeholder={t.drills.placeholder} onChange={(event) => setName(event.target.value)} />
            </label>
            <button type="submit" className={styles.chip} disabled={!name.trim()}>
              {t.drills.save}
            </button>
          </form>
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
            label={t.play.label}
            value={settings.play}
            options={PLAYS.map((value) => ({ value, label: t.play[value] }))}
            onChange={(play) => onChange({ play })}
          />
          <Chips
            label={t.deal}
            value={settings.deal}
            options={DEAL_BIASES.map((value) => ({ value, label: t.deals[value] ?? value }))}
            onChange={(deal) => onChange({ deal })}
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
          <Chips
            label={t.facts}
            value={settings.facts ? "on" : "off"}
            options={[
              { value: "on", label: t.on },
              { value: "off", label: t.off },
            ]}
            onChange={(value) => onChange({ facts: value === "on" })}
          />
        </section>
      </div>
    </div>
  );
}
