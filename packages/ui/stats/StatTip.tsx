/**
 * A statistic's hover box, the one every statistics surface shows (the
 * "Hover opisi" design, 2026-11-17): the full name with the short label
 * beside it, the value, what the statistic counts, then one line per number
 * - the sample (made out of chances for a rate), the definition's ideal
 * (target) range, and only while the sample is short, how much sample the
 * statistic needs. Hovering a statistic's name shows the same box without a
 * value.
 *
 * It replaces the native `title` tooltip ("n = 80, 95% CI 20.0–39.5%"),
 * which said nothing a reader could use. Nothing here computes a statistic:
 * the value, its sample and reliability arrive in the `Shown`, the range from
 * the definition's bands (`range.ts`). A rate's "made" count is read back
 * from the value it was divided into (`pct(made, chances)` is made · 100 /
 * chances, exact in a double, so rounding returns the integer).
 *
 * `useStatTip()` gives a surface one box: spread `on(subject)` on each
 * element that has one, render `layer` once. The box sits under the element
 * (over it when the window has no room below), in a portal so a table's
 * overflow cannot clip it, and closes on scroll.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { useUiStrings } from "../i18n";
import type { Shown, StatDefinition } from "../model/stats";
import { textLocale } from "../reports/definitions";
import { countIn } from "./format";
import { targetRange } from "./range";
import { decimalMark, shownText } from "./StatValue";
import styles from "./StatTip.module.css";

export interface StatTipSubject {
  /** The statistic: its name, label, description, sample minimum and range. */
  definition?: StatDefinition;
  /** The value hovered; absent on a statistic's name. */
  shown?: Shown | null;
  /** Overrides the definition's full name (a street row's "Continuation bet"). */
  name?: string;
  /** Overrides the definition's short label. */
  label?: string;
  /** Overrides the definition's description. */
  description?: string;
  /** Where the value sits, after the name: a position ("BTN"). */
  context?: string;
}

/** What `on(subject)` spreads on the element that opens the box. */
export interface StatTipTrigger {
  onMouseEnter: (event: MouseEvent<HTMLElement>) => void;
  onMouseLeave: () => void;
  onFocus: (event: FocusEvent<HTMLElement>) => void;
  onBlur: () => void;
}

interface Open {
  subject: StatTipSubject;
  anchor: DOMRect;
}

/** How long the pointer rests before the first box opens; the next ones follow at once. */
const OPEN_DELAY_MS = 180;
/** The gap between the element and the box, and the box and the window's edge. */
const GAP = 6;
const EDGE = 8;

export function useStatTip(): {
  on: (subject: StatTipSubject) => StatTipTrigger;
  layer: ReactNode;
} {
  const [open, setOpen] = useState<Open | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shownRef = useRef(false);

  const clear = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };

  const show = useCallback((subject: StatTipSubject, element: HTMLElement) => {
    clear();
    const anchor = element.getBoundingClientRect();
    if (shownRef.current) {
      setOpen({ subject, anchor });
      return;
    }
    timer.current = setTimeout(() => {
      shownRef.current = true;
      setOpen({ subject, anchor });
    }, OPEN_DELAY_MS);
  }, []);

  const hide = useCallback(() => {
    clear();
    shownRef.current = false;
    setOpen(null);
  }, []);

  useEffect(() => {
    if (open === null) return;
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [open, hide]);

  useEffect(() => clear, []);

  const on = (subject: StatTipSubject): StatTipTrigger => ({
    onMouseEnter: (event) => show(subject, event.currentTarget),
    onMouseLeave: hide,
    onFocus: (event) => show(subject, event.currentTarget),
    onBlur: hide,
  });

  const layer =
    open === null || typeof document === "undefined"
      ? null
      : createPortal(<Positioned anchor={open.anchor} subject={open.subject} />, document.body);

  return { on, layer };
}

function Positioned({ anchor, subject }: { anchor: DOMRect; subject: StatTipSubject }) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const box = ref.current;
    if (!box) return;
    const width = box.offsetWidth;
    const height = box.offsetHeight;
    const maxLeft = window.innerWidth - width - EDGE;
    const left = Math.max(EDGE, Math.min(maxLeft, anchor.left + anchor.width / 2 - width / 2));
    const below = anchor.bottom + GAP;
    const above = anchor.top - GAP - height;
    const top = below + height <= window.innerHeight - EDGE || above < EDGE ? below : above;
    box.style.left = `${left}px`;
    box.style.top = `${Math.max(EDGE, top)}px`;
    box.style.visibility = "visible";
  }, [anchor, subject]);

  return (
    <div ref={ref} role="tooltip" className={styles.tip}>
      <StatTipCard subject={subject} />
    </div>
  );
}

/** The box's content; exported for a surface that lays it out itself. */
export function StatTipCard({ subject }: { subject: StatTipSubject }) {
  const all = useUiStrings();
  const t = all.statTip;
  const locale = all.intlLocale;
  const text = textLocale(locale);
  const count = countIn(locale);
  const mark = decimalMark(locale);
  const { definition, shown } = subject;

  const fullName = subject.name ?? definition?.name[text] ?? subject.label ?? "";
  const label = subject.label ?? definition?.label[text];
  const description = subject.description ?? definition?.description[text];
  const unit = definition?.format.unit;
  const min = definition?.sample.min ?? 0;
  const sampleOf = definition?.sample.of;
  const things = (n: number) =>
    sampleOf === undefined ? t.chances(n) : sampleOf.includes("hands") ? t.hands(n) : t.actions(n);

  const rows: {
    key: string;
    label: string;
    value: string;
    note?: string;
    level?: string;
  }[] = [];

  // A count of hands is its own sample: no line for it.
  if (shown && shown.sample !== null && !(unit === "count" && shown.value === shown.sample)) {
    const sample = shown.sample;
    // A rate (`pct(made, chances)`, the only kind with an interval): its made count.
    const made =
      shown.reliability.interval !== null && shown.value !== null ? Math.round((shown.value * sample) / 100) : null;
    rows.push({
      key: "sample",
      label: t.sample,
      value: made === null ? things(sample) : `${count(made)} / ${count(sample)}`,
    });
  }

  const range = definition ? targetRange(definition) : null;
  if (range && unit) {
    const bound = (value: number) => `${String(value).replace(".", mark)}${unit === "percent" ? "%" : ""}`;
    rows.push({
      key: "range",
      label: t.idealRange,
      value:
        range.low !== null && range.high !== null
          ? `${String(range.low).replace(".", mark)}–${bound(range.high)}`
          : range.low !== null
            ? t.atLeast(bound(range.low))
            : t.below(bound(range.high as number)),
    });
  }

  if (min > 0 && (!shown || shown.reliability.level !== "ok")) {
    const level = shown?.reliability.level;
    rows.push({
      key: "needed",
      label: t.sampleNeeded,
      value: things(min),
      note: level === "low" ? t.short.low : level === "insufficient" ? t.short.insufficient : undefined,
      level,
    });
  }

  const value = shown && unit ? shownText(shown, unit, mark, count) : null;
  const signed = unit === "bb_per_100" || unit === "bb" || unit === "money";
  const sign = shown?.value != null && signed && shown.value !== 0 ? (shown.value > 0 ? "profit" : "loss") : undefined;

  return (
    <>
      <div className={styles.head}>
        <span className={styles.name}>{subject.context ? `${fullName} · ${subject.context}` : fullName}</span>
        {label && label !== fullName ? <span className={styles.label}>{label}</span> : null}
      </div>
      {value !== null && shown ? (
        <div className={styles.value} data-sign={sign} style={{ opacity: shown.reliability.opacity }}>
          {value}
        </div>
      ) : null}
      {description ? <p className={styles.description}>{description}</p> : null}
      {rows.length > 0 ? (
        <dl className={styles.rows}>
          {rows.map((row) => (
            <div key={row.key} className={styles.row}>
              <dt>{row.label}</dt>
              <dd>
                {row.level ? <i className={styles.dot} data-level={row.level} aria-hidden="true" /> : null}
                {row.value}
              </dd>
              {row.note ? <dd className={styles.note}>{row.note}</dd> : null}
            </div>
          ))}
        </dl>
      ) : null}
    </>
  );
}
