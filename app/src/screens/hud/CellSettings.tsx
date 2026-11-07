/**
 * A panel cell's settings (R3.9), in a popover by the cell they belong to -
 * on the panel's grid or on a number of the preview. Rows, the name on the
 * left and the control on the right: the decimals; from how many hands it
 * takes full colour (`StatOverride.minSample`); its colour limits as
 * presets - Suggested (the definition's bands), Tighter game, Looser game -
 * or Custom (number inputs filled with the preset picked); a value to try
 * against them; and whether it shows only at some stack depths
 * (`Cell.when`). Escape or a click elsewhere closes it; Tab stays inside.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import { useLocale, useT } from "../../i18n";
import type { DesignBand, DesignCell, HudStat, StatOverride } from "../../lib/ipc";
import { Toggle } from "../settings/Toggle";
import styles from "./HudEditor.module.css";

type Preset = "suggested" | "tighter" | "looser";
const PRESETS: readonly Preset[] = ["suggested", "tighter", "looser"];

/**
 * Tighter and Looser from Suggested: every limit times 0.87 (a tighter
 * game: the same play reads looser against it, so every limit comes down
 * by about an eighth) or times 1.15 (a looser game: up by about a seventh),
 * rounded to as many decimals as the suggested limit is written with; a
 * limit that rounds onto the one below it goes one step (a unit of its last
 * decimal) above it, so the limits still go up. The colours stay the
 * definition's. Stored as the user's bands (`StatOverride.bands`), which
 * the Rust side checks like any other.
 */
const FACTOR: Record<Exclude<Preset, "suggested">, number> = { tighter: 0.87, looser: 1.15 };

const decimalsOf = (n: number) => {
  const text = String(n);
  const dot = text.indexOf(".");
  return dot < 0 || text.includes("e") ? 0 : text.length - dot - 1;
};
const round = (n: number, decimals: number) => Number(n.toFixed(decimals));

function scaled(bands: readonly DesignBand[], factor: number): DesignBand[] {
  let previous = -Infinity;
  return bands.map((band) => {
    if (band.below === undefined) return { ...band };
    const decimals = decimalsOf(band.below);
    let below = round(band.below * factor, decimals);
    if (below <= previous) below = round(previous + 10 ** -decimals, decimals);
    previous = below;
    return { ...band, below };
  });
}

const bandsOf = (suggested: readonly DesignBand[], preset: Preset): DesignBand[] =>
  preset === "suggested" ? suggested.map((band) => ({ ...band })) : scaled(suggested, FACTOR[preset]);

const same = (a: readonly DesignBand[], b: readonly DesignBand[]) =>
  a.length === b.length && a.every((band, i) => band.tone === b[i]?.tone && band.below === b[i]?.below);

/** Which preset `own` is (`undefined`: Suggested), or custom. */
function presetOf(own: readonly DesignBand[] | undefined, suggested: readonly DesignBand[]): Preset | "custom" {
  if (own === undefined) return "suggested";
  return PRESETS.find((preset) => suggested.length > 0 && same(own, bandsOf(suggested, preset))) ?? "custom";
}

const limitsOf = (bands: readonly DesignBand[]) =>
  bands.filter((band): band is DesignBand & { below: number } => band.below !== undefined).map((band) => band.below);

/** The band a value falls in (`DisplayStat::tone`'s rule: below the first limit it is under). */
const toneAt = (bands: readonly DesignBand[], value: number) =>
  bands.find((band) => band.below === undefined || value < band.below)?.tone;

/** The strip of colours: each band's share of the range its limits span. */
function BandBar({ bands }: { bands: readonly DesignBand[] }) {
  const limits = limitsOf(bands);
  const low = Math.min(0, ...limits);
  const high = (limits.at(-1) ?? 1) * 1.25 || 1;
  const ends = bands.map((band) => band.below ?? high);
  return (
    <span className={styles.bandBar} aria-hidden="true">
      {bands.map((band, i) => {
        const share = Math.max((ends[i] ?? high) - (i === 0 ? low : (ends[i - 1] ?? low)), (high - low) * 0.06);
        return <span key={i} data-tone={band.tone} style={{ flexGrow: share }} />;
      })}
    </span>
  );
}

export function CellSettings({
  anchor,
  cell,
  stat,
  override,
  maxDecimals,
  onClose,
  onRemove,
  onCell,
  onOverride,
}: {
  /** What it opens by: a panel cell, a number on the preview. */
  anchor: Element;
  cell: DesignCell;
  stat: HudStat | undefined;
  override: StatOverride;
  maxDecimals: number;
  onClose: () => void;
  onRemove: () => void;
  onCell: (next: DesignCell) => void;
  onOverride: (next: StatOverride) => void;
}) {
  const h = useT().hudEditor;
  const locale = useLocale();
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  const suggested = stat?.bands ?? [];
  const own = override.bands;
  const [custom, setCustom] = useState(() => presetOf(own, suggested) === "custom");
  const picked = custom ? "custom" : presetOf(own, suggested);
  const bands = own ?? suggested;
  const [limitText, setLimitText] = useState<string[]>(() => limitsOf(bands).map(String));
  const [tried, setTried] = useState("");
  const sample = override.minSample ?? stat?.minSample ?? 0;
  const labelText = stat?.label[locale] ?? cell.stat;

  // By the anchor: to its right when there is room, else to its left, else
  // under it; kept on screen. Again on every render (the cell may move) and
  // when the page scrolls or resizes.
  const position = () => {
    const el = box.current;
    if (!el || !anchor.isConnected) return;
    const a = anchor.getBoundingClientRect();
    const { offsetWidth: w, offsetHeight: hgt } = el;
    const gap = 12;
    const margin = 8;
    let left = a.right + gap;
    let top = a.top - 16;
    if (left + w > window.innerWidth - margin) left = a.left - gap - w;
    if (left < margin) {
      left = Math.max(margin, Math.min(a.left, window.innerWidth - w - margin));
      top = a.bottom + gap;
    }
    top = Math.max(margin, Math.min(top, window.innerHeight - hgt - margin));
    setPlace((old) => (old && old.top === top && old.left === left ? old : { top, left }));
  };
  useLayoutEffect(position);
  useEffect(() => {
    const again = () => position();
    window.addEventListener("scroll", again, true);
    window.addEventListener("resize", again);
    return () => {
      window.removeEventListener("scroll", again, true);
      window.removeEventListener("resize", again);
    };
  });

  // Back to what opened it: the cell, or the preview panel the number is on.
  const close = () => {
    onClose();
    const back = anchor.closest<HTMLElement | SVGElement>("button, [tabindex]");
    back?.focus();
  };
  // A click outside closes it (the anchor's own click toggles it).
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!box.current?.contains(target) && !anchor.contains(target)) onClose();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [anchor, onClose]);
  // Focus moves in once it is placed (to the popover itself: Tab goes on
  // to its first control).
  const placed = place !== null;
  useEffect(() => {
    if (placed) box.current?.focus();
  }, [placed]);

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const all = [...(box.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select") ?? [])];
    const first = all[0];
    const last = all.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === box.current)) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  const pick = (preset: Preset | "custom") => {
    if (preset === "custom") {
      setCustom(true);
      const start = bandsOf(suggested, picked === "custom" ? "suggested" : picked);
      setLimitText(limitsOf(own ?? start).map(String));
      onOverride({ ...override, bands: own ?? start });
      return;
    }
    setCustom(false);
    setLimitText(limitsOf(bandsOf(suggested, preset)).map(String));
    onOverride({ ...override, bands: preset === "suggested" ? undefined : bandsOf(suggested, preset) });
  };
  const setLimit = (index: number, text: string) => {
    const next = limitText.map((value, i) => (i === index ? text : value));
    setLimitText(next);
    let at = 0;
    const edited = bands.map((band) => {
      if (band.below === undefined) return { tone: band.tone };
      const value = Number((next[at++] ?? "").replace(",", "."));
      return { tone: band.tone, below: Number.isFinite(value) ? value : band.below };
    });
    onOverride({ ...override, bands: edited });
  };
  const setSample = (value: number) => {
    const n = Math.max(0, Math.round(value));
    onOverride({ ...override, minSample: n === stat?.minSample ? undefined : n });
  };

  const decimalChoices: (number | "default")[] = ["default", ...Array.from({ length: maxDecimals + 1 }, (_, i) => i)];
  const triedValue = Number(tried.replace(",", "."));
  const triedTone = tried.trim() !== "" && Number.isFinite(triedValue) ? toneAt(bands, triedValue) : undefined;
  const coloured = suggested.length > 0 || own !== undefined;

  return (
    <div
      ref={box}
      className={styles.popover}
      role="dialog"
      tabIndex={-1}
      aria-label={h.cellSettings(labelText)}
      style={place ? { top: place.top, left: place.left } : { opacity: 0, pointerEvents: "none" }}
      onKeyDown={onKey}
    >
      <header className={styles.popHead}>
        <span className={styles.popTitle}>
          <strong>{labelText}</strong>
          <span>{stat?.name[locale] ?? ""}</span>
        </span>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onRemove}>
          {h.remove}
        </button>
      </header>

      <div className={styles.popRow}>
        <span id={`${id}-dec`}>{h.decimals}</span>
        <div className={styles.pills} role="radiogroup" aria-labelledby={`${id}-dec`}>
          {decimalChoices.map((choice) => {
            const on = (override.decimals ?? "default") === choice;
            return (
              <button
                key={choice}
                type="button"
                role="radio"
                aria-checked={on}
                className={`chip-btn${on ? " is-active" : ""}`}
                onClick={() => onOverride({ ...override, decimals: choice === "default" ? undefined : choice })}
              >
                {choice === "default" ? h.decimalsDefault : choice}
              </button>
            );
          })}
        </div>
      </div>

      <div className={styles.popRow}>
        <span id={`${id}-sample`}>{h.minSample}</span>
        <div className={styles.stepper} role="group" aria-labelledby={`${id}-sample`}>
          <button type="button" aria-label={h.fewerHands} onClick={() => setSample(sample - 10)} disabled={sample <= 0}>
            −
          </button>
          <span className={styles.stepValue}>
            <input
              type="number"
              min={0}
              aria-label={h.minSample}
              value={sample}
              onChange={(event) => setSample(Number(event.target.value))}
            />
            <span>{h.minSampleUnit}</span>
          </span>
          <button type="button" aria-label={h.moreHands} onClick={() => setSample(sample + 10)}>
            +
          </button>
        </div>
      </div>

      {coloured ? (
        <div className={styles.presets} role="radiogroup" aria-label={h.bands}>
          {suggested.length > 0
            ? PRESETS.map((preset) => {
                const shown = bandsOf(suggested, preset);
                return (
                  <button
                    key={preset}
                    type="button"
                    role="radio"
                    aria-checked={picked === preset}
                    className={picked === preset ? `${styles.preset} ${styles.presetOn}` : styles.preset}
                    onClick={() => pick(preset)}
                  >
                    <span className={styles.radio} aria-hidden="true" />
                    <span className={styles.presetName}>{h.bandPresets[preset]}</span>
                    <BandBar bands={shown} />
                    <span className={styles.presetLimits}>{limitsOf(shown).join(" · ")}</span>
                  </button>
                );
              })
            : null}
          {picked === "custom" ? (
            <div className={`${styles.preset} ${styles.presetOn} ${styles.presetCustom}`}>
              <div className={styles.customHead}>
                <span className={styles.radioOn} aria-hidden="true" />
                <span className={styles.presetName}>{h.bandPresets.custom}</span>
                <button type="button" className={styles.linkButton} onClick={() => pick("suggested")}>
                  {h.resetSuggested}
                </button>
              </div>
              <BandBar bands={bands} />
              <div className={styles.customLimits}>
                {limitText.map((text, i) => (
                  <input
                    key={i}
                    className={styles.limitInput}
                    inputMode="decimal"
                    aria-label={h.bandLimit(i + 1)}
                    value={text}
                    onChange={(event) => setLimit(i, event.target.value)}
                  />
                ))}
              </div>
            </div>
          ) : (
            <button
              type="button"
              role="radio"
              aria-checked={false}
              className={`${styles.preset} ${styles.presetMore}`}
              onClick={() => pick("custom")}
            >
              {h.bandPresets.customMore}
            </button>
          )}
        </div>
      ) : (
        <p className={styles.hint}>{h.bandsNone}</p>
      )}

      {coloured ? (
        <div className={styles.popRow}>
          <label htmlFor={`${id}-try`}>{h.tryValue}</label>
          <span className={styles.tryValue}>
            <input
              id={`${id}-try`}
              className={styles.limitInput}
              inputMode="decimal"
              value={tried}
              onChange={(event) => setTried(event.target.value)}
            />
            <span className={styles.toneChip} data-tone={triedTone} aria-live="polite">
              {triedTone ? h.tones[triedTone] : "—"}
            </span>
          </span>
        </div>
      ) : null}

      <div className={styles.popRow}>
        <label htmlFor={`${id}-stack`} title={h.stackHint}>
          {h.stack}
        </label>
        <Toggle
          id={`${id}-stack`}
          checked={cell.when !== undefined}
          onChange={(on) => onCell(on ? { ...cell, when: { atLeastBb: 20 } } : { stat: cell.stat })}
        />
      </div>
      {cell.when ? (
        <div className={styles.popRow}>
          <span className={styles.hintWarn}>{h.stackHint}</span>
          <span className={styles.stackRange}>
            <input
              type="number"
              min={1}
              max={1000}
              className={styles.limitInput}
              aria-label={h.stackAtLeast}
              value={cell.when.atLeastBb ?? ""}
              onChange={(event) =>
                onCell({
                  ...cell,
                  when: { ...cell.when, atLeastBb: event.target.value === "" ? undefined : Number(event.target.value) },
                })
              }
            />
            <span>{h.stackTo}</span>
            <input
              type="number"
              min={1}
              max={1000}
              className={styles.limitInput}
              aria-label={h.stackBelow}
              value={cell.when.belowBb ?? ""}
              onChange={(event) =>
                onCell({
                  ...cell,
                  when: { ...cell.when, belowBb: event.target.value === "" ? undefined : Number(event.target.value) },
                })
              }
            />
            <span>{h.stackUnit}</span>
          </span>
        </div>
      ) : null}
    </div>
  );
}
