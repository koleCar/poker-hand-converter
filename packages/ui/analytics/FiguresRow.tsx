/**
 * The figures row (docs/ANALYTICS.md Step 4; board AN-Main): hands, then
 * won, all-in EV, showdown and non-showdown per 100 hands, signed and
 * coloured in the chosen unit, and the bb | $ toggle that also sets the
 * graph's unit. Shared by Overview, Streets and All stats. The rates are the
 * graph's end (`figuresOf`), so the row and the curve agree.
 */
import { countIn } from "../hands/format";
import { useUiStrings } from "../i18n";
import { numberFormat } from "../stats/format";
import type { WinrateGraphMoney } from "../stats/WinrateGraph";
import type { Report } from "../reports/model";
import styles from "./Analytics.module.css";
import { figuresOf } from "./view";

export function FiguresRow({
  report,
  unit,
  money,
  onUnit,
}: {
  report: Report;
  unit: "bb" | "money";
  money: WinrateGraphMoney | null;
  onUnit: (unit: "bb" | "money") => void;
}) {
  const ui = useUiStrings();
  const f = ui.analytics.screen.figures;
  const r = ui.reports;
  const { units } = report;
  const figures = figuresOf(report.graph, report.summary.hands, unit, units.minorUnits);
  const signed = numberFormat(ui.intlLocale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    signDisplay: "exceptZero",
  });
  const text = (value: number | null) =>
    value === null ? "—" : unit === "money" && money ? money.format(value) : signed.format(value);
  const tone = (value: number | null) =>
    value === null || Math.abs(value) < 0.05 ? undefined : value > 0 ? styles.up : styles.down;
  const chips = units.minorUnits !== null && units.minorUnits <= 1;
  const moneyName = chips ? r.graph.chips : (units.symbol ?? units.currency ?? r.graph.money);
  const rate = f.per100(unit === "money" && money ? moneyName : f.bb);
  const entries: [string, number | null][] = [
    [f.won, figures.won],
    [f.allInEv, figures.allInEv],
    [f.showdown, figures.showdown],
    [f.nonShowdown, figures.nonShowdown],
  ];
  return (
    <div className={styles.bar}>
      <dl className={styles.figures} aria-label={f.label}>
        <div className={`${styles.figure} ${styles.lead}`}>
          <dt>{f.hands(figures.hands)}</dt>
          <dd>{countIn(ui.intlLocale, figures.hands)}</dd>
        </div>
        {entries.map(([label, value], index) => (
          <div key={label} className={styles.figure}>
            <dt>{label}</dt>
            <dd>
              <span className={tone(value)}>{text(value)}</span>
              {index === 0 ? <span className={styles.rate}> {rate}</span> : null}
            </dd>
          </div>
        ))}
      </dl>
      <span className={styles.spacer} />
      <div className={styles.seg} role="group" aria-label={f.unit}>
        <button
          type="button"
          className={`chip-btn${unit === "bb" ? " is-active" : ""}`}
          aria-pressed={unit === "bb"}
          onClick={() => onUnit("bb")}
        >
          {f.bb}
        </button>
        <button
          type="button"
          className={`chip-btn${unit === "money" ? " is-active" : ""}`}
          aria-pressed={unit === "money"}
          disabled={money === null}
          onClick={() => onUnit("money")}
        >
          {moneyName}
        </button>
      </div>
    </div>
  );
}
