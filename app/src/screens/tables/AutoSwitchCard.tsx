/**
 * (T5 follow-up) Switch by table count: "N or more tables → layout X",
 * lowest count first, written to `TilingSettings.autoSwitch`. The engine
 * (`Engine::effective`) reads the layout in force's own rules when it has
 * any, else these; nothing in the app writes a layout's own rules, so
 * these are the ones in force unless a layout came with its own (then a
 * line says so and offers to drop them). The rule the open tables reach
 * now (`tiling_status`) is marked. Every change is checked as
 * `check_rules` checks it before it is saved.
 */
import { useState } from "react";

import { useT } from "../../i18n";
import type { HudStatus, TilingSettings } from "../../lib/ipc";
import { NumberField } from "./RngCard";
import {
  AUTO_LAYOUT,
  MAX_RULES,
  addRule,
  clearOwnRules,
  effectiveRules,
  removeRule,
  ruleInForce,
  rulesProblem,
  setRuleCount,
  setRuleLayout,
  sortRules,
} from "./slots";
import styles from "./Tables.module.css";

/** The most tables a rule may name (beyond any real session). */
const MAX_COUNT = 99;

export function AutoSwitchCard({
  settings,
  status,
  onSave,
}: {
  settings: TilingSettings;
  status: HudStatus | null;
  onSave: (next: TilingSettings) => void;
}) {
  const t = useT().tables;
  const s = t.autoSwitch;
  const [problem, setProblem] = useState<string | null>(null);
  // Bumped on a refused change, so the count fields show the stored counts again.
  const [refusals, setRefusals] = useState(0);
  const rules = sortRules(settings.autoSwitch);
  const { own } = effectiveRules(settings);
  const report = status?.tiling ?? null;
  const tables = report !== null && report.enabled && settings.enabled ? report.tables : null;
  const current = own === null && tables !== null ? ruleInForce(rules, tables) : null;

  const save = (next: TilingSettings | null) => {
    if (next === null) return;
    const found = rulesProblem(next.autoSwitch, next.layouts);
    if (found !== null) {
      setProblem(t.editor.problem[found]);
      setRefusals((n) => n + 1);
      return;
    }
    setProblem(null);
    onSave(next);
  };

  const layouts = [{ id: AUTO_LAYOUT, name: t.auto }, ...settings.layouts.map((l) => ({ id: l.id, name: l.name }))];
  return (
    <section className={styles.card} aria-label={s.label}>
      <div className={styles.line}>
        <span className={styles.cardTitle}>{s.label}</span>
        <button type="button" className="btn btn--sm btn--ghost" disabled={rules.length >= MAX_RULES} onClick={() => save(addRule(settings))}>
          {s.add}
        </button>
      </div>
      {own !== null ? (
        <div className={styles.line}>
          <span className={styles.warn}>{s.own(own.name)}</span>
          <button type="button" className={styles.textButton} onClick={() => save(clearOwnRules(settings, own.id))}>
            {s.useThese}
          </button>
        </div>
      ) : null}
      {rules.length > 0 ? (
        <ul className={styles.rules}>
          {rules.map((rule, index) => {
            const on = current !== null && current.minTables === rule.minTables;
            return (
              <li key={`${rule.minTables}:${index}`} className={styles.rule} data-active={on}>
                <NumberField
                  key={`${rule.minTables}:${refusals}`}
                  label={s.count}
                  value={rule.minTables}
                  min={1}
                  max={MAX_COUNT}
                  onCommit={(count) => save(setRuleCount(settings, index, count))}
                />
                <span className={styles.ruleText}>{s.orMore}</span>
                <span aria-hidden="true">→</span>
                <select
                  className={`${styles.input} ${styles.select}`}
                  aria-label={s.layout}
                  value={rule.layoutId}
                  onChange={(e) => save(setRuleLayout(settings, index, e.target.value))}
                >
                  {layouts.map((layout) => (
                    <option key={layout.id} value={layout.id}>
                      {layout.name}
                    </option>
                  ))}
                </select>
                {on && tables !== null ? (
                  <span className={styles.inForce} title={s.inForceHint(tables)}>
                    {s.inForce}
                  </span>
                ) : null}
                <button
                  type="button"
                  className={`btn btn--sm btn--ghost ${styles.ruleRemove}`}
                  aria-label={s.remove}
                  title={s.remove}
                  onClick={() => save(removeRule(settings, index))}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {problem !== null ? <p className={styles.error}>{problem}</p> : null}
    </section>
  );
}
