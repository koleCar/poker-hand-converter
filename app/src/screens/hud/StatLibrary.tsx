/**
 * The HUD editor's statistics library (R3.9): every statistic a panel may
 * show (never the hero's own, never money), found by name, by group. A
 * chip is dragged onto the panel or into a popup section; a click (or
 * Enter) adds it to the end of the panel. What is on the panel already is
 * ticked; the user's own and the ones that read the cards are marked.
 */
import { useState } from "react";
import type { StatGroup } from "@rail/ui/model/stats";

import { useLocale, useT } from "../../i18n";
import type { HudStat } from "../../lib/ipc";
import { useDrag } from "./drag";
import styles from "./HudEditor.module.css";

const GROUPS: readonly StatGroup[] = ["preflop", "postflop", "showdown", "results"];

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
  const [group, setGroup] = useState<StatGroup | "all">("all");

  const palette = stats.filter((stat) => !stat.heroOnly && !stat.money);
  const needle = query.trim().toLowerCase();
  const matches = (stat: HudStat) =>
    needle === "" ||
    stat.label[locale].toLowerCase().includes(needle) ||
    stat.name[locale].toLowerCase().includes(needle) ||
    stat.id.includes(needle);
  const shown = palette.filter((stat) => (group === "all" || stat.group === group) && matches(stat));
  const count = (g: StatGroup | "all") => palette.filter((stat) => (g === "all" || stat.group === g) && matches(stat)).length;

  return (
    <div className={styles.library}>
      <div className={styles.libraryBar}>
        <input
          type="search"
          className={styles.search}
          value={query}
          placeholder={h.paletteSearch}
          aria-label={h.paletteSearch}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className={styles.tabs} role="tablist" aria-label={h.palette}>
          {(["all", ...GROUPS] as const).map((g) => (
            <button
              key={g}
              type="button"
              role="tab"
              aria-selected={group === g}
              className={group === g ? `${styles.tab} ${styles.tabOn}` : styles.tab}
              onClick={() => setGroup(g)}
            >
              {g === "all" ? h.allGroups : t.reports.stats.groups[g]}
              <span className={styles.tabCount}>{count(g)}</span>
            </button>
          ))}
        </div>
      </div>
      <ul className={styles.chips} aria-label={h.palette}>
        {shown.map((stat) => {
          const placed = onPanel(stat.id);
          return (
            <li key={stat.id}>
              <button
                type="button"
                className={[
                  styles.statChip,
                  placed ? styles.statChipPlaced : "",
                  dragging?.kind === "stat" && dragging.id === stat.id ? styles.statChipDragged : "",
                ].join(" ")}
                title={stat.description[locale]}
                aria-label={placed ? `${stat.label[locale]}, ${h.onPanel}` : h.addNamed(stat.label[locale])}
                aria-disabled={placed || full}
                onPointerDown={(event) => begin(event, { kind: "stat", id: stat.id, label: stat.label[locale] })}
                onClick={() => {
                  if (!placed && !full) onAdd(stat.id);
                }}
              >
                <span className={styles.statChipLabel}>
                  {placed ? <span className={styles.tick} aria-hidden="true">✓</span> : null}
                  {stat.label[locale]}
                </span>
                <span className={styles.statChipName}>{stat.name[locale]}</span>
                {stat.custom || stat.cardSplit ? (
                  <span className={styles.statChipBadges}>
                    {stat.custom ? <span className={styles.badge}>{h.yours}</span> : null}
                    {stat.cardSplit ? <span className={styles.badgeWarn}>{h.cards}</span> : null}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      {shown.length === 0 ? <p className={styles.hint}>{h.noMatch}</p> : null}
      <p className={styles.hint}>{h.paletteHint}</p>
    </div>
  );
}
