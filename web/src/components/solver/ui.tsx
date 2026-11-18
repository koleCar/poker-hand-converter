/**
 * The Solver's small controls ("Studio", SV-A), shared by every part of the
 * screen and by the desktop app's nodelock (through `app/src/solver/door.ts`),
 * so a slot's tools look like the library's own:
 *
 * - `Segmented`: a joined pill of options (`Strategy + EV | Ranges`, the
 *   table's format), as tabs or as pressed buttons;
 * - `IconButton`: a square icon-only button (copy a link, close);
 * - `ToolButton`: a labelled toolbar button, `tone="lock"` in the lock colours;
 * - `Switch`: a labelled on/off toggle (Compare with GTO);
 * - `Chip`: a removable pill (an active hand filter);
 * - `MixBar`: a strategy as one stacked bar, a segment per action;
 * - `SignedBb`: a signed amount, green above zero and red below;
 * - `Popover`: a panel under its anchor that Esc or a click outside closes.
 *
 * Colours and sizes are the app's tokens (`solver.module.css`).
 */

"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import styles from "./solver.module.css";

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
  disabled?: boolean;
}

/** A joined pill of options; `tabs` makes it a tablist (a view switch), else pressed buttons. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  size = "md",
  tabs = false,
  className = "",
}: {
  options: ReadonlyArray<SegmentOption<T>>;
  value: T;
  onChange: (value: T) => void;
  label: string;
  size?: "sm" | "md";
  tabs?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`${styles.seg} ${size === "sm" ? styles.segSm : ""} ${className}`}
      role={tabs ? "tablist" : "group"}
      aria-label={label}
    >
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role={tabs ? "tab" : undefined}
            aria-selected={tabs ? on : undefined}
            aria-pressed={tabs ? undefined : on}
            className={on ? styles.segOn : undefined}
            title={option.title}
            disabled={option.disabled}
            onClick={() => {
              if (!on) onChange(option.value);
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** A square, icon-only button: its `label` is its name and its tooltip. */
export function IconButton({
  label,
  onClick,
  children,
  size = "md",
  pressed,
  disabled,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  size?: "sm" | "md";
  pressed?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`${styles.iconButton} ${size === "sm" ? styles.iconButtonSm : ""}`}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** A labelled toolbar button; `lock` in the lock colours (the app's Nodelock action). */
export function ToolButton({
  onClick,
  children,
  tone = "plain",
  size = "md",
  title,
  disabled,
}: {
  onClick: () => void;
  children: ReactNode;
  tone?: "plain" | "lock" | "primary";
  size?: "sm" | "md";
  title?: string;
  disabled?: boolean;
}) {
  const toneClass = tone === "lock" ? styles.toolButtonLock : tone === "primary" ? styles.toolButtonPrimary : "";
  return (
    <button
      type="button"
      className={`${styles.toolButton} ${toneClass} ${size === "sm" ? styles.toolButtonSm : ""}`}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** A labelled on/off switch. */
export function Switch({ on, onChange, children }: { on: boolean; onChange: (on: boolean) => void; children: ReactNode }) {
  return (
    <button type="button" role="switch" aria-checked={on} className={styles.switch} onClick={() => onChange(!on)}>
      <span className={styles.switchTrack} aria-hidden="true" />
      {children}
    </button>
  );
}

/** A removable pill: clicking it removes it (`label` names that). `out` for an exclusion. */
export function Chip({ children, label, onRemove, out = false }: { children: ReactNode; label: string; onRemove: () => void; out?: boolean }) {
  return (
    <button type="button" className={`${styles.chip} ${out ? styles.chipOut : ""}`} aria-label={label} title={label} onClick={onRemove}>
      {children}
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    </button>
  );
}

/**
 * A mix as one stacked bar: a segment per action in its colour class
 * (`actionColours`). `reach` (0..1) shortens the filled part, the rest an
 * empty track: how much of a combo gets here.
 */
export function MixBar({
  mix,
  colours,
  thin = false,
  reach = 1,
}: {
  mix: readonly number[];
  colours: readonly string[];
  thin?: boolean;
  reach?: number;
}) {
  const total = mix.reduce((sum, m) => sum + Math.max(0, m), 0) || 1;
  return (
    <span className={`${styles.mixBar} ${thin ? styles.mixBarThin : ""}`} aria-hidden="true">
      <span className={styles.mixBarFill} style={{ inlineSize: `${Math.max(0, Math.min(1, reach)) * 100}%` }}>
        {mix.map((m, a) =>
          m > 0 ? <span key={a} className={colours[a]} style={{ inlineSize: `${(m / total) * 100}%` }} /> : null,
        )}
      </span>
    </span>
  );
}

/** A signed amount: green above zero, red below, quiet at zero. `text` is how it reads (the dictionary's). */
export function SignedBb({ value, text, className = "" }: { value: number; text: string; className?: string }) {
  const rounded = Math.round(value * 100);
  const tone = rounded > 0 ? styles.evPos : rounded < 0 ? styles.evNeg : styles.evZero;
  return <span className={`${tone} ${className}`}>{text}</span>;
}

/** The lock glyph, for the lock colours' buttons and marks. */
export function LockGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.glyph}>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

/** A chevron pointing down: a control that opens a list. */
export function ChevronDown() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={styles.glyph}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/**
 * A panel under its anchor, inside the nearest positioned box: Esc or a
 * pointer down outside it (and outside `anchor`, the button that toggles it)
 * closes it. `left` places it along the box, in pixels.
 */
export function Popover({
  onClose,
  anchor,
  label,
  left = 0,
  wide = false,
  children,
}: {
  onClose: () => void;
  anchor?: RefObject<HTMLElement | null>;
  label: string;
  left?: number;
  wide?: boolean;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  // Kept inside its box: moved left when it would run past the right edge.
  const [shift, setShift] = useState(Math.max(0, left));
  useLayoutEffect(() => {
    const element = panel.current;
    const box = element?.offsetParent as HTMLElement | null;
    if (!element || !box) return;
    setShift(Math.max(0, Math.min(left, box.clientWidth - element.offsetWidth)));
  }, [left]);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const down = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || panel.current?.contains(target) || anchor?.current?.contains(target)) return;
      close.current();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
    };
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key);
    };
  }, [anchor]);
  return (
    <div
      ref={panel}
      className={`${styles.popover} ${wide ? styles.popoverWide : ""}`}
      role="dialog"
      aria-label={label}
      style={{ insetInlineStart: `${shift}px` }}
    >
      {children}
    </div>
  );
}
