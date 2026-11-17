/**
 * Settings, RNG (the owner's briefs of 2026-11-16 and 2026-11-17): the
 * RNG box (`src-tauri/src/rng_box.rs`) - a number from 1 to 100 while a
 * session is live. Its switch, then (while on) its look and place: lock,
 * "Reposition" (the middle of the screen, unlocked, to be dragged where
 * the user wants it), the box's size, the number's size, background and
 * number colours. Everything is `RngSettings`, stored and synced as
 * before; the box takes it as soon as it is saved. While this section is
 * on screen the box shows (switch on), so what is styled is seen.
 */
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import { useT } from "../../i18n";
import {
  errorText,
  inApp,
  ipc,
  onTilingSettingsChanged,
  RNG_BOX,
  RNG_NUMBER,
  type RngSettings,
} from "../../lib/ipc";
import styles from "./Settings.module.css";
import { Toggle } from "./Toggle";

/** Saves wait this long after the last change (a slider being dragged). */
const SAVE_AFTER_MS = 150;

/** A theme colour (`--surface-raised`) as `#rrggbb`, for a colour field that has no colour of the user's. */
function themeHex(token: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx || !value) return "#000000";
  ctx.fillStyle = value;
  const out = ctx.fillStyle;
  return /^#[0-9a-f]{6}$/i.test(out) ? out : "#000000";
}

function Row({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: string; children: ReactNode }) {
  return (
    <div className={`${styles.row} ${styles.rowWide}`} title={hint}>
      <label htmlFor={htmlFor}>{label}</label>
      <div className={styles.actions}>{children}</div>
    </div>
  );
}

function Slider({
  id,
  value,
  min,
  max,
  label,
  onChange,
}: {
  id?: string;
  value: number;
  min: number;
  max: number;
  label?: string;
  onChange: (value: number) => void;
}) {
  return (
    <span className={styles.inline}>
      <input
        id={id}
        type="range"
        className={styles.range}
        min={min}
        max={max}
        step={1}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className={`${styles.mono} ${styles.muted}`}>{value}</span>
    </span>
  );
}

export function Rng() {
  const t = useT().settings;
  const ids = { show: useId(), lock: useId(), width: useId(), number: useId(), bg: useId(), fg: useId() };
  const [rng, setRng] = useState<RngSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const section = useRef<HTMLDivElement>(null);
  const pending = useRef<number | null>(null);

  // Read again when a sync brought another computer's settings, or the box was dragged.
  useEffect(() => onTilingSettingsChanged(() => setGeneration((g) => g + 1)), []);
  useEffect(() => {
    let live = true;
    ipc
      .getRngSettings()
      .then((settings) => live && setRng(settings))
      .catch((e: unknown) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [generation]);

  // The box shows while this section is on screen.
  useEffect(() => {
    const node = section.current;
    if (!inApp || !node) return;
    let shown = false;
    const tell = (on: boolean) => {
      if (on === shown) return;
      shown = on;
      ipc.rngBoxPreview(on).catch(() => undefined);
    };
    const observer = new IntersectionObserver((entries) => tell(entries.some((e) => e.isIntersecting)));
    observer.observe(node);
    return () => {
      observer.disconnect();
      tell(false);
    };
  }, []);

  useEffect(
    () => () => {
      if (pending.current !== null) window.clearTimeout(pending.current);
    },
    [],
  );

  const save = (next: RngSettings, later = false) => {
    setRng(next);
    setError(null);
    if (pending.current !== null) window.clearTimeout(pending.current);
    const run = () => {
      pending.current = null;
      ipc.setRngSettings(next).catch((e: unknown) => {
        setError(errorText(e));
        setGeneration((g) => g + 1);
      });
    };
    if (later) pending.current = window.setTimeout(run, SAVE_AFTER_MS);
    else run();
  };

  const change = (patch: Partial<RngSettings>, later = false) => {
    if (rng !== null) save({ ...rng, ...patch }, later);
  };

  const reposition = () => {
    setError(null);
    ipc
      .rngBoxReposition()
      .then(setRng)
      .catch((e: unknown) => setError(errorText(e)));
  };

  const resetLook = () =>
    change({
      width: RNG_BOX.initial,
      height: RNG_BOX.initial,
      numberSize: RNG_NUMBER.initial,
      background: null,
      color: null,
    });

  return (
    <div ref={section}>
      <div className={styles.card}>
        <div className={`${styles.row} ${styles.rowWide}`} title={t.rng.hint}>
          <label htmlFor={ids.show}>{t.rng.show}</label>
          <Toggle
            id={ids.show}
            checked={rng?.enabled ?? false}
            disabled={rng === null}
            onChange={(on) => change({ enabled: on })}
          />
        </div>
      </div>
      {rng?.enabled && (
        <div className={`${styles.card} ${styles.cardAfter}`}>
          <Row label={t.rng.lock} htmlFor={ids.lock} hint={t.rng.lockHint}>
            <Toggle id={ids.lock} checked={rng.locked} onChange={(on) => change({ locked: on })} />
          </Row>
          <Row label={rng.position ? t.rng.placedByYou : t.rng.placedInCorner} hint={t.rng.repositionHint}>
            <button type="button" className="btn btn--ghost btn--sm" onClick={reposition}>
              {t.rng.reposition}
            </button>
          </Row>
          <Row label={t.rng.boxSize} htmlFor={ids.width}>
            <Slider
              id={ids.width}
              label={t.rng.width}
              value={rng.width}
              min={RNG_BOX.min}
              max={RNG_BOX.max}
              onChange={(width) => change({ width }, true)}
            />
            <span className={styles.muted}>×</span>
            <Slider
              label={t.rng.height}
              value={rng.height}
              min={RNG_BOX.min}
              max={RNG_BOX.max}
              onChange={(height) => change({ height }, true)}
            />
          </Row>
          <Row label={t.rng.numberSize} htmlFor={ids.number}>
            <Slider
              id={ids.number}
              value={rng.numberSize}
              min={RNG_NUMBER.min}
              max={RNG_NUMBER.max}
              onChange={(numberSize) => change({ numberSize }, true)}
            />
          </Row>
          <Row label={t.rng.background} htmlFor={ids.bg}>
            {rng.background && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => change({ background: null })}>
                {t.rng.theme}
              </button>
            )}
            <input
              id={ids.bg}
              type="color"
              className={styles.swatch}
              value={rng.background ?? themeHex("--surface-raised")}
              onChange={(e) => change({ background: e.target.value }, true)}
            />
          </Row>
          <Row label={t.rng.color} htmlFor={ids.fg}>
            {rng.color && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => change({ color: null })}>
                {t.rng.theme}
              </button>
            )}
            <input
              id={ids.fg}
              type="color"
              className={styles.swatch}
              value={rng.color ?? themeHex("--text-primary")}
              onChange={(e) => change({ color: e.target.value }, true)}
            />
          </Row>
          <div className={`${styles.row} ${styles.rowWide}`}>
            <span className={styles.muted}>{t.rng.dragHint}</span>
            <button type="button" className="btn btn--ghost btn--sm" onClick={resetLook}>
              {t.rng.resetLook}
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className={`${styles.note} ${styles.error}`} role="alert">
          {t.saveFailed(error)}
        </p>
      )}
    </div>
  );
}
