/**
 * The Live screen's statistics (the owner's variant C, 2026-11-05): one tile
 * each, its short label (`VPIP`, `3B`, the definition's `label`) over its
 * value, the value coloured by how far it sits from the middle of its target
 * range (the definition's "normal" band) - green in the middle, through amber
 * to red well outside - and a strip under it with the band and the value's
 * mark. A win rate has no target: its colour is its sign. Hovering or
 * focusing a tile shows its full name, the target and where the value sits.
 *
 * The tooltip is placed after it renders, against the window: under the
 * tile when it fits, else above, and slid sideways to stay inside, so it is
 * whole at any window size. A scroll or a resize closes it.
 */
import { textLocale } from "@rail/ui/reports/definitions";
import { decimalMark, shownText } from "@rail/ui/stats/StatValue";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

import { useLocale, useT } from "../../i18n";
import { formatLocale } from "../../i18n/format";
import type { Session } from "../../lib/ipc";
import { useStatDefinitions } from "../../lib/useStatDefinitions";
import { LIVE_STATS, placeOf, rangeBar, rangeColour, rangeScore, targetRange, type RangeBar, type TargetRange } from "./model";
import styles from "./Live.module.css";

/** Room kept between the tooltip and the window's edge, and the tile. */
const EDGE = 12;
const GAP = 8;

interface Tile {
  id: string;
  label: string;
  name: string;
  value: string;
  target: string | null;
  /** The value's colour (a CSS colour), null when it has none. */
  colour: string | null;
  bar: RangeBar | null;
}

function rangeText(range: TargetRange, mark: string): string {
  const number = (value: number) => String(value).replace(".", mark);
  if (range.low === null) return `< ${number(range.high ?? 0)}%`;
  if (range.high === null) return `≥ ${number(range.low)}%`;
  return `${number(range.low)}–${number(range.high)}%`;
}

export function LiveStats({ session }: { session: Session }) {
  const t = useT();
  const d = t.live.stats;
  const locale = textLocale(useLocale());
  const definitions = useStatDefinitions();
  if (definitions === null) return null;

  const mark = decimalMark(formatLocale());
  const tiles: Tile[] = [];
  for (const id of LIVE_STATS) {
    // `session.stats` is in the definitions' order (the shipped ones first).
    const index = definitions.findIndex((definition) => definition.id === id);
    const definition = definitions[index];
    const shown = session.stats[index];
    if (!definition || !shown) continue;
    const range = targetRange(definition);
    const place = placeOf(shown.tone);
    const value = shown.value;
    let colour: string | null = null;
    let bar: RangeBar | null = null;
    if (value !== null && range) {
      colour = rangeColour(rangeScore(value, range));
      bar = rangeBar(value, range);
    }
    tiles.push({
      id,
      label: definition.label[locale],
      name: definition.name[locale],
      value: shownText(shown, definition.format.unit, mark),
      target: range ? `${d.target(rangeText(range, mark))}${place ? ` · ${d[place]}` : ""}` : null,
      colour,
      bar,
    });
  }

  return (
    <section className={styles.section} aria-label={d.label}>
      <ul className={styles.stats}>
        {tiles.map((tile) => (
          <li key={tile.id}>
            <StatTile tile={tile} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function StatTile({ tile }: { tile: Tile }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties>({ visibility: "hidden" });
  const anchor = useRef<HTMLButtonElement | null>(null);
  const tip = useRef<HTMLDivElement | null>(null);
  const tipId = useId();

  const show = () => {
    setPlace({ visibility: "hidden" });
    setOpen(true);
  };

  // Placed once it has a size: under the tile if it fits, else above, and
  // inside the window's width.
  useLayoutEffect(() => {
    if (!open) return;
    const a = anchor.current?.getBoundingClientRect();
    const b = tip.current?.getBoundingClientRect();
    if (!a || !b) return;
    const width = document.documentElement.clientWidth;
    const height = document.documentElement.clientHeight;
    const left = Math.max(EDGE, Math.min(a.left, width - EDGE - b.width));
    const below = a.bottom + GAP + b.height <= height - EDGE || a.top - GAP - b.height < EDGE;
    setPlace({ left, top: below ? a.bottom + GAP : a.top - GAP - b.height });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={styles.stat}
        aria-label={`${tile.name}: ${tile.value}`}
        aria-describedby={open && tile.target ? tipId : undefined}
        onMouseEnter={show}
        onMouseLeave={() => setOpen(false)}
        onFocus={show}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
      >
        <span className={styles.statLabel}>{tile.label}</span>
        <span className={styles.statValue} style={tile.colour ? { color: tile.colour } : undefined}>
          {tile.value}
        </span>
        {tile.bar ? (
          <span className={styles.rangeBar} aria-hidden="true">
            <span className={styles.rangeBand} style={{ left: `${tile.bar.bandLeft}%`, right: `${tile.bar.bandRight}%` }} />
            <span
              className={styles.rangeMark}
              style={{ left: `${tile.bar.mark}%`, background: tile.colour ?? "var(--text-secondary)" }}
            />
          </span>
        ) : null}
      </button>
      {open ? (
        <div ref={tip} id={tipId} role="tooltip" className={styles.tip} style={place}>
          <strong className={styles.tipName}>{tile.name}</strong>
          {tile.target ? <span className={styles.tipTarget}>{tile.target}</span> : null}
        </div>
      ) : null}
    </>
  );
}
