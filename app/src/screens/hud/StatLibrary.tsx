/**
 * The HUD editor's statistics (R3.9): a drawer beside the editor with every
 * statistic a panel may show (never the hero's own, never money) - by group
 * (Preflop, Postflop, Showdown, Results; the user's own under Yours), each
 * group opened and closed by its name - or, as soon as something is typed,
 * a list of what matches by abbreviation or name. A chip is dragged onto
 * the panel or into a popup section; a click (or Enter) adds it to the
 * panel's first empty slot. What is on the panel already is dimmed; one
 * that reads the cards (which PokerStars does not allow) is marked.
 */
import { useState } from "react";
import type { StatGroup } from "@rail/ui/model/stats";

import { useLocale, useT } from "../../i18n";
import type { HudStat } from "../../lib/ipc";
import { useDrag } from "./drag";
import styles from "./HudEditor.module.css";

type Shelf = StatGroup | "yours";
const SHELVES: readonly Shelf[] = ["preflop", "postflop", "showdown", "results", "yours"];

export function StatLibrary({
  stats,
  onPanel,
  full,
  onAdd,
}: {
  stats: readonly HudStat[];
  onPanel: (id: string) => boolean;
  full: boolean;
  onAdd: (id: string) => void;
}) {
  const t = useT();
  const h = t.hudEditor;
  const locale = useLocale();
  const { begin, dragging } = useDrag();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<ReadonlySet<Shelf>>(() => new Set(["preflop"]));

  const palette = stats.filter((stat) => !stat.heroOnly && !stat.money);
  const shelfOf = (stat: HudStat): Shelf => (stat.custom ? "yours" : stat.group);
  const needle = query.trim().toLowerCase();
  const found = palette.filter(
    (stat) =>
      stat.label[locale].toLowerCase().includes(needle) ||
      stat.name[locale].toLowerCase().includes(needle) ||
      stat.id.includes(needle),
  );

  const chip = (stat: HudStat, row: boolean) => {
    const placed = onPanel(stat.id);
    return (
      <button
        type="button"
        className={[
          row ? styles.statRow : styles.statChip,
          placed ? styles.statPlaced : "",
          stat.cardSplit ? styles.statCards : "",
          dragging?.kind === "stat" && dragging.id === stat.id ? styles.statDragged : "",
        ].join(" ")}
        title={`${stat.name[locale]}${stat.cardSplit ? ` (${h.cards})` : ""}`}
        aria-label={placed ? `${stat.label[locale]}, ${h.onPanel}` : h.addNamed(stat.label[locale], stat.name[locale])}
        aria-disabled={placed || full}
        onPointerDown={(event) => begin(event, { kind: "stat", id: stat.id, label: stat.label[locale] })}
        onClick={() => {
          if (!placed && !full) onAdd(stat.id);
        }}
      >
        <span className={styles.statLabel}>{stat.label[locale]}</span>
        {row ? <span className={styles.statName}>{stat.name[locale]}</span> : null}
      </button>
    );
  };

  return (
    <div className={styles.library}>
      <div className={styles.searchWrap}>
        <input
          type="search"
          className={styles.search}
          value={query}
          placeholder={h.paletteSearch}
          aria-label={h.paletteSearch}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query !== "") {
              event.preventDefault();
              setQuery("");
            }
          }}
        />
        {query !== "" ? (
          <kbd className={styles.escHint} aria-hidden="true">
            {h.escKey}
          </kbd>
        ) : null}
      </div>

      {needle !== "" ? (
        <ul className={styles.found} aria-label={h.palette}>
          {found.map((stat) => (
            <li key={stat.id}>{chip(stat, true)}</li>
          ))}
          {found.length === 0 ? <li className={styles.hint}>{h.noMatch}</li> : null}
        </ul>
      ) : (
        SHELVES.map((shelf) => {
          const items = palette.filter((stat) => shelfOf(stat) === shelf);
          if (items.length === 0) return null;
          const expanded = open.has(shelf);
          const name = shelf === "yours" ? h.yoursShelf : t.reports.stats.groups[shelf];
          return (
            <section key={shelf} className={styles.shelf}>
              <button
                type="button"
                className={styles.shelfHead}
                aria-expanded={expanded}
                onClick={() =>
                  setOpen((was) => {
                    const next = new Set(was);
                    if (expanded) next.delete(shelf);
                    else next.add(shelf);
                    return next;
                  })
                }
              >
                <span className={styles.shelfName}>{name}</span>
                <span className={styles.shelfCount}>{items.length}</span>
                <span className={styles.shelfArrow} aria-hidden="true">
                  {expanded ? "▾" : "▸"}
                </span>
              </button>
              {expanded ? (
                <ul className={styles.chips} aria-label={name}>
                  {items.map((stat) => (
                    <li key={stat.id}>{chip(stat, false)}</li>
                  ))}
                </ul>
              ) : null}
            </section>
          );
        })
      )}
      <p className={styles.drawerHint}>{h.paletteHint}</p>
    </div>
  );
}
