/**
 * The settings of the panel cell picked (R3.9): what the statistic is, how
 * many decimals, from how many hands it takes full colour, its colour bands
 * (the definition's, or the user's own - drawn as the strip of colours the
 * HUD uses) and whether it shows only at some stack depths.
 */
import { useId, useState } from "react";
import type { StatTone } from "@rail/ui/model/stats";

import { useLocale, useT } from "../../i18n";
import type { DesignBand, DesignCell, HudStat, StatOverride } from "../../lib/ipc";
import styles from "./HudEditor.module.css";

const TONES: readonly StatTone[] = ["very-low", "low", "normal", "high", "very-high"];

/** One band as the form holds it: the limit as typed. */
interface BandForm {
  below: string;
  tone: StatTone;
}

const formOf = (bands: readonly DesignBand[]): BandForm[] =>
  bands.map((band) => ({ below: band.below === undefined ? "" : String(band.below), tone: band.tone }));

/** The strip of colours: each band's share, its tone, the limits between. */
function BandStrip({ bands }: { bands: readonly BandForm[] }) {
  const h = useT().hudEditor;
  if (bands.length === 0) return <p className={styles.hint}>{h.bandsNone}</p>;
  return (
    <div className={styles.bandStrip} aria-hidden="true">
      {bands.map((band, i) => (
        <div key={i} className={styles.bandPart} data-tone={band.tone}>
          <span className={styles.bandSwatch} />
          <span className={styles.bandLimit}>
            {i === bands.length - 1 ? h.bandRest : band.below === "" ? "…" : h.bandBelowShort(band.below)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function CellSettings({
  index,
  cell,
  stat,
  override,
  maxDecimals,
  count,
  onMove,
  onRemove,
  onCell,
  onOverride,
}: {
  index: number;
  cell: DesignCell;
  stat: HudStat | undefined;
  override: StatOverride;
  maxDecimals: number;
  count: number;
  onMove: (to: number) => void;
  onRemove: () => void;
  onCell: (next: DesignCell) => void;
  onOverride: (next: StatOverride) => void;
}) {
  const h = useT().hudEditor;
  const locale = useLocale();
  const id = useId();
  const [bands, setBands] = useState<BandForm[]>(() => formOf(override.bands ?? stat?.bands ?? []));
  const own = override.bands !== undefined;
  const shown = own ? bands : formOf(stat?.bands ?? []);

  const commitBands = (next: BandForm[]) => {
    setBands(next);
    const parsed: DesignBand[] = next.map((band, i) =>
      i === next.length - 1 || band.below.trim() === ""
        ? { tone: band.tone }
        : { below: Number(band.below.replace(",", ".")), tone: band.tone },
    );
    onOverride({ ...override, bands: parsed });
  };

  const decimalChoices: (number | "default")[] = ["default", ...Array.from({ length: maxDecimals + 1 }, (_, i) => i)];

  return (
    <div className={styles.settings}>
      <header className={styles.inspectorHead}>
        <div className={styles.inspectorName}>
          <span className={styles.inspectorLabel}>{stat?.label[locale] ?? cell.stat}</span>
          <span className={styles.inspectorTitle}>{stat?.name[locale] ?? cell.stat}</span>
        </div>
        <div className={styles.iconRow}>
          <button
            type="button"
            className={styles.iconButton}
            disabled={index === 0}
            aria-label={h.moveEarlier}
            title={h.moveEarlier}
            onClick={() => onMove(index - 1)}
          >
            ←
          </button>
          <button
            type="button"
            className={styles.iconButton}
            disabled={index >= count - 1}
            aria-label={h.moveLater}
            title={h.moveLater}
            onClick={() => onMove(index + 1)}
          >
            →
          </button>
          <button type="button" className={`${styles.iconButton} ${styles.iconDanger}`} onClick={onRemove}>
            {h.remove}
          </button>
        </div>
      </header>
      {stat?.description[locale] ? <p className={styles.inspectorText}>{stat.description[locale]}</p> : null}

      <div className={styles.group}>
        <h4 className={styles.groupLabel}>{h.display}</h4>
        <div className={styles.inlineField}>
          <span className={styles.fieldLabel} id={`${id}-dec`}>
            {h.decimals}
          </span>
          <div className={styles.segmented} role="radiogroup" aria-labelledby={`${id}-dec`}>
            {decimalChoices.map((choice) => {
              const on = (override.decimals ?? "default") === choice;
              return (
                <button
                  key={choice}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  className={on ? `${styles.segment} ${styles.segmentOn}` : styles.segment}
                  onClick={() => onOverride({ ...override, decimals: choice === "default" ? undefined : choice })}
                >
                  {choice === "default" ? h.decimalsDefault : choice}
                </button>
              );
            })}
          </div>
        </div>
        <label className={styles.inlineField}>
          <span className={styles.fieldLabel}>{h.minSample}</span>
          <span className={styles.withUnit}>
            <input
              type="number"
              min={0}
              className={styles.inputNarrow}
              value={override.minSample ?? ""}
              placeholder={String(stat?.minSample ?? "")}
              onChange={(event) =>
                onOverride({
                  ...override,
                  minSample: event.target.value === "" ? undefined : Math.max(0, Math.floor(Number(event.target.value))),
                })
              }
            />
            <span className={styles.unit}>{h.minSampleUnit}</span>
          </span>
        </label>
      </div>

      <div className={styles.group}>
        <div className={styles.groupHead}>
          <h4 className={styles.groupLabel}>{h.bands}</h4>
          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={own}
              onChange={(event) => {
                if (event.target.checked) {
                  commitBands(bands.length > 0 ? bands : [{ below: "", tone: "normal" }]);
                } else {
                  onOverride({ ...override, bands: undefined });
                  setBands(formOf(stat?.bands ?? []));
                }
              }}
            />
            <span>{h.bandsOwn}</span>
          </label>
        </div>
        <BandStrip bands={shown} />
        {own ? (
          <>
            <p className={styles.hint}>{h.bandsHint}</p>
            {bands.map((band, i) => {
              const last = i === bands.length - 1;
              return (
                <div key={i} className={styles.bandRow}>
                  <span className={styles.bandDot} data-tone={band.tone} aria-hidden="true" />
                  <select
                    className={styles.inputSm}
                    value={band.tone}
                    aria-label={h.bandTone(i + 1)}
                    onChange={(event) =>
                      commitBands(bands.map((b, j) => (j === i ? { ...b, tone: event.target.value as StatTone } : b)))
                    }
                  >
                    {TONES.map((tone) => (
                      <option key={tone} value={tone}>
                        {h.tones[tone]}
                      </option>
                    ))}
                  </select>
                  {last ? (
                    <span className={styles.unit}>{h.bandRest}</span>
                  ) : (
                    <span className={styles.withUnit}>
                      <span className={styles.unit}>{h.bandBelowWord}</span>
                      <input
                        className={styles.inputNarrow}
                        inputMode="decimal"
                        value={band.below}
                        aria-label={h.bandBelow(i + 1)}
                        onChange={(event) =>
                          commitBands(bands.map((b, j) => (j === i ? { ...b, below: event.target.value } : b)))
                        }
                      />
                    </span>
                  )}
                  <button
                    type="button"
                    className={styles.iconButton}
                    aria-label={h.removeBand(i + 1)}
                    title={h.removeBand(i + 1)}
                    disabled={bands.length <= 1}
                    onClick={() => commitBands(bands.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              className={styles.linkButton}
              disabled={bands.length >= 5}
              onClick={() => commitBands([...bands.slice(0, -1), { below: "", tone: "normal" }, ...bands.slice(-1)])}
            >
              + {h.addBand}
            </button>
          </>
        ) : null}
      </div>

      <div className={styles.group}>
        <div className={styles.groupHead}>
          <h4 className={styles.groupLabel}>{h.stackLegend}</h4>
          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={cell.when !== undefined}
              aria-describedby={`${id}-stack`}
              onChange={(event) => onCell(event.target.checked ? { ...cell, when: { belowBb: 20 } } : { stat: cell.stat })}
            />
            <span>{h.stack}</span>
          </label>
        </div>
        {cell.when ? (
          <div className={styles.row}>
            <label className={styles.inlineField}>
              <span className={styles.fieldLabel}>{h.stackAtLeast}</span>
              <input
                type="number"
                min={1}
                max={1000}
                className={styles.inputNarrow}
                value={cell.when.atLeastBb ?? ""}
                onChange={(event) =>
                  onCell({
                    ...cell,
                    when: { ...cell.when, atLeastBb: event.target.value === "" ? undefined : Number(event.target.value) },
                  })
                }
              />
            </label>
            <label className={styles.inlineField}>
              <span className={styles.fieldLabel}>{h.stackBelow}</span>
              <input
                type="number"
                min={1}
                max={1000}
                className={styles.inputNarrow}
                value={cell.when.belowBb ?? ""}
                onChange={(event) =>
                  onCell({
                    ...cell,
                    when: { ...cell.when, belowBb: event.target.value === "" ? undefined : Number(event.target.value) },
                  })
                }
              />
            </label>
          </div>
        ) : null}
        <p id={`${id}-stack`} className={styles.hintWarn}>
          {h.stackHint}
        </p>
      </div>
    </div>
  );
}
