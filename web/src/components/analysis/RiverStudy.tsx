/**
 * The river and turn study (`docs/ANALYSIS-PLAN.md` §6.1 *Study*, phases A4
 * and A5a): the hero's whole range at a solved node, as the solver plays it.
 *
 *   grid        13×13, each hand class with the solver's mix over the combos
 *               of it the hero's range holds here (reach-weighted), the
 *               hero's class outlined; hover, focus or press a class for its
 *               mix and EV per action
 *   totals      what the whole range does, in % and combos
 *   by hand     made hands, missed draws (river) or draws (turn), nothing —
 *               each with its mix
 *   by strength value / bluff-catchers / air against the opponent's range
 *   opponent    the opponent's range at the node, by the same categories
 *
 * Nothing here is stored (§3.4): the button re-runs the same walk and the
 * same deterministic solve the grade came from (`studyRiver` / `studyTurn`,
 * in the analysis worker), so the hero's own row equals the stored options.
 *
 * Accessibility follows `ChartGrid`: one tab stop with arrow keys, every cell
 * a button named in words, a polite live region for the detail, and colour
 * never alone — every action is named in the legend, the detail and the
 * tables' text.
 */

"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { villainsOfFacts } from "../../lib/analysis/analyze";
import type { DecisionAnalysis } from "../../lib/analysis/types";
import type { RiverStudy as Study, StudyOption, StudyRow } from "../../lib/analysis/river";
import { studyRiver, studyTurn } from "../../lib/db";
import { useDict } from "../../lib/i18n/client";
import type { PhfHand } from "../../lib/phf/types";
import styles from "./analysis.module.css";
import own from "./riverStudy.module.css";
import { GRID_CELLS } from "./chartSpots";

type Loaded =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "missing" }
  | { status: "ready"; study: Study };

/** The fill class of each option: bets by size, small to large; raises and all-in their own. */
export function actionClasses(options: readonly StudyOption[]): string[] {
  const bets = options
    .map((option, index) => ({ option, index }))
    .filter(({ option }) => option.action === "bet" && !option.allIn)
    .sort((a, b) => (a.option.sizePot ?? 0) - (b.option.sizePot ?? 0));
  const betRank = new Map(bets.map(({ index }, rank) => [index, rank]));
  return options.map((option, index) => {
    if (option.allIn) return styles.actAllin;
    switch (option.action) {
      case "fold":
        return styles.actFold;
      case "check":
        return styles.actCheck;
      case "call":
        return styles.actCall;
      case "raise":
        return styles.actRaise;
      default: {
        const rank = betRank.get(index) ?? 0;
        return rank === 0 ? own.actBetSmall : rank === 1 ? own.actBetMedium : styles.actRaise;
      }
    }
  });
}

interface RiverStudyProps {
  decision: DecisionAnalysis;
  hand: PhfHand;
  /** Open (and solve) at once: the trainer shows the whole range after every answer. */
  initialOpen?: boolean;
  /** The street of the decision: the river (A4) or the turn (A5a). */
  street?: "river" | "turn";
  /**
   * A river study: narrow into the river through the solved turn, as the
   * analysis does (default), or by the heuristic all the way, as the river
   * trainer's spots are built.
   */
  solveTurn?: boolean;
}

/** The study's strings: the river's, with the turn's own where they differ. */
export function useStudyStrings(street: "river" | "turn") {
  const analysis = useDict().analysis;
  return street === "turn" ? { ...analysis.river, ...analysis.turn } : analysis.river;
}

/** The button and, once asked for, the study itself. */
export function RiverStudy({ decision, hand, initialOpen = false, street = "river", solveTurn = true }: RiverStudyProps) {
  const t = useStudyStrings(street);
  const [open, setOpen] = useState(initialOpen);
  const [loaded, setLoaded] = useState<Loaded>({ status: initialOpen ? "loading" : "idle" });
  const started = useRef(false);

  const load = () => {
    started.current = true;
    // analysis/20: the opponents' statistics the stored grade read, not today's.
    const villains = decision.facts.villain ? villainsOfFacts(hand, decision.facts.villain) : null;
    (street === "turn"
      ? studyTurn(hand, decision.actionIndex, { villains })
      : studyRiver(hand, decision.actionIndex, { turn: solveTurn, villains }))
      .then((study) => {
        if (study && "options" in study) setLoaded({ status: "ready", study });
        else setLoaded({ status: "missing" });
      })
      .catch((reason: unknown) => {
        setLoaded({ status: "error", message: reason instanceof Error ? reason.message : String(reason) });
      });
  };

  // Opened from the start: solve once, on mount.
  useEffect(() => {
    if (initialOpen && !started.current) load();
    // Once, on mount; `load` closes over the decision this instance was made for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && loaded.status === "idle") {
      setLoaded({ status: "loading" });
      load();
    }
  };

  return (
    <div className={styles.study}>
      <div className={styles.studyActions}>
        <button type="button" className="btn btn--sm" aria-expanded={open} onClick={toggle}>
          {open ? t.hideStudy : t.study}
        </button>
      </div>
      {open && loaded.status === "loading" ? (
        <p className={styles.hint} role="status">
          {t.loading}
        </p>
      ) : null}
      {open && loaded.status === "error" ? <p className="notice notice--error">{t.failed(loaded.message)}</p> : null}
      {open && loaded.status === "missing" ? <p className="notice notice--warn">{t.unavailable}</p> : null}
      {open && loaded.status === "ready" ? <StudyBody study={loaded.study} /> : null}
    </div>
  );
}

function useLabels(options: readonly StudyOption[]): string[] {
  const s = useDict().analysis.sheet;
  return options.map((option) => s.option(option.action, option.sizeBb ?? undefined, option.allIn, option.sizePot ?? undefined));
}

/** A stacked bar of a mix, with its words for assistive technology. */
function MixBar({ row, classes, labels }: { row: StudyRow; classes: string[]; labels: string[] }) {
  const t = useDict().analysis.river;
  const words = t.mixLabel(row.freq.map((freq, a) => (freq >= 0.005 ? t.part(labels[a], freq) : "")).filter(Boolean));
  return (
    <span className={own.mix}>
      <span className={own.mixBar} aria-hidden="true">
        {row.freq.map((freq, a) => (freq > 0 ? <span key={a} className={classes[a]} style={{ inlineSize: `${freq * 100}%` }} /> : null))}
      </span>
      <span className={own.mixText}>{words}</span>
    </span>
  );
}

function StudyBody({ study }: { study: Study }) {
  const t = useStudyStrings(study.street ?? "river");
  const labels = useLabels(study.options);
  const classes = useMemo(() => actionClasses(study.options), [study.options]);
  const groups = study.street === "turn" ? (["made", "draws", "nothing"] as const) : (["made", "missed", "nothing"] as const);

  return (
    <div className={own.body}>
      <div className={styles.chartHead}>
        <h4 className={styles.subhead}>{t.heading}</h4>
        <p className={styles.muted}>{t.note}</p>
      </div>

      <ul className={styles.chartLegend} aria-label={t.spot(study.path)}>
        {study.options.map((option, a) => (
          <li key={a}>
            <span className={`${styles.swatch} ${classes[a]}`} aria-hidden="true" />
            {t.totals(labels[a], option.share, option.combos)}
          </li>
        ))}
      </ul>

      <RiverGrid study={study} labels={labels} classes={classes} />

      <section aria-label={t.categoriesTitle}>
        <h4 className={styles.subhead}>{t.categoriesTitle}</h4>
        <div className="stats-table-wrap">
          <table className={`stats-table ${own.table}`}>
            <thead>
              <tr>
                <th scope="col">{t.colHand}</th>
                <th scope="col" className="num">
                  {t.colCombos}
                </th>
                <th scope="col">{t.colMix}</th>
              </tr>
            </thead>
            {groups.map((group) => {
              const rows = study.categories.filter((row) => row.group === group);
              if (rows.length === 0) return null;
              return (
                <tbody key={group}>
                  <tr className={own.groupRow}>
                    <th scope="colgroup" colSpan={3}>
                      {t.groups[group]}
                    </th>
                  </tr>
                  {rows.map((row) => (
                    <tr key={row.key}>
                      <th scope="row">{t.categories[row.key] ?? row.key}</th>
                      <td className="num">{t.combos(row.combos)}</td>
                      <td>
                        <MixBar row={row} classes={classes} labels={labels} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              );
            })}
          </table>
        </div>
      </section>

      <section aria-label={t.strengthTitle}>
        <h4 className={styles.subhead}>{t.strengthTitle}</h4>
        <div className="stats-table-wrap">
          <table className={`stats-table ${own.table}`}>
            <thead>
              <tr>
                <th scope="col">{t.colHand}</th>
                <th scope="col" className="num">
                  {t.colCombos}
                </th>
                <th scope="col">{t.colMix}</th>
              </tr>
            </thead>
            <tbody>
              {study.strength.map((row) => (
                <tr key={row.key}>
                  <th scope="row">{t.strength[row.key] ?? row.key}</th>
                  <td className="num">{t.combos(row.combos)}</td>
                  <td>
                    <MixBar row={row} classes={classes} labels={labels} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-label={t.villainTitle}>
        <h4 className={styles.subhead}>{t.villainTitle}</h4>
        <p className={styles.muted}>
          {t.villainSummary(
            study.villain.combos,
            study.villain.strength.strong,
            study.villain.strength.medium,
            study.villain.strength.weak,
          )}
        </p>
        <ul className={own.villain}>
          {study.villain.categories.map((row) => (
            <li key={row.key}>
              <span>{t.categories[row.key] ?? row.key}</span>
              <span className={own.villainBar} aria-hidden="true">
                <span style={{ inlineSize: `${Math.min(1, row.share) * 100}%` }} />
              </span>
              <span className={styles.num}>{t.share(row.share)}</span>
            </li>
          ))}
        </ul>
      </section>

      <p className={styles.muted}>{t.solved(study.iterations, study.exploitabilityPct)}</p>
      <p className={styles.muted}>{t.evNote}</p>
    </div>
  );
}

function RiverGrid({ study, labels, classes }: { study: Study; labels: string[]; classes: string[] }) {
  const t = useStudyStrings(study.street ?? "river");
  const startIndex = Math.max(0, GRID_CELLS.findIndex((cell) => cell.name === study.heroClass));
  const [focusIndex, setFocusIndex] = useState(startIndex);
  const [hovered, setHovered] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const shown = hovered ?? picked ?? study.heroClass;
  const shownIndex = GRID_CELLS.findIndex((cell) => cell.name === shown);
  const detail = shownIndex >= 0 ? study.cells[shownIndex] : null;
  const spot = t.spot(study.path);

  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const row = Math.floor(index / 13);
    const col = index % 13;
    let next = index;
    switch (event.key) {
      case "ArrowRight":
        next = row * 13 + Math.min(12, col + 1);
        break;
      case "ArrowLeft":
        next = row * 13 + Math.max(0, col - 1);
        break;
      case "ArrowDown":
        next = Math.min(12, row + 1) * 13 + col;
        break;
      case "ArrowUp":
        next = Math.max(0, row - 1) * 13 + col;
        break;
      case "Home":
        next = row * 13;
        break;
      case "End":
        next = row * 13 + 12;
        break;
      default:
        return;
    }
    event.preventDefault();
    setFocusIndex(next);
    setPicked(GRID_CELLS[next].name);
    buttons.current[next]?.focus();
  };

  return (
    <div className={styles.chart}>
      <div className={styles.chartBody}>
        <div className={styles.grid} role="grid" aria-label={t.gridLabel(spot)}>
          {Array.from({ length: 13 }, (_, row) => (
            <div key={row} role="row" className={styles.gridRow}>
              {GRID_CELLS.slice(row * 13, row * 13 + 13).map((cell, col) => {
                const index = row * 13 + col;
                const data = study.cells[index];
                const empty = !data || data.combos <= 0;
                const name = t.cellLabel(
                  cell.name,
                  data?.combos ?? 0,
                  (data?.freq ?? []).map((freq, a) => (freq >= 0.005 ? t.part(labels[a], freq) : "")).filter(Boolean),
                );
                return (
                  <div key={cell.name} role="gridcell" className={styles.gridCellWrap}>
                    <button
                      ref={(element) => {
                        buttons.current[index] = element;
                      }}
                      type="button"
                      tabIndex={index === focusIndex ? 0 : -1}
                      className={`${styles.gridCell}${empty ? ` ${styles.offRange}` : ""}${
                        cell.name === study.heroClass ? ` ${styles.heroCell}` : ""
                      }${cell.name === shown ? ` ${styles.shownCell}` : ""}`}
                      aria-label={name}
                      aria-pressed={cell.name === picked}
                      onClick={() => {
                        setFocusIndex(index);
                        setPicked(cell.name === picked ? null : cell.name);
                      }}
                      onFocus={() => setFocusIndex(index)}
                      onKeyDown={(event) => move(event, index)}
                      onPointerEnter={() => setHovered(cell.name)}
                      onPointerLeave={() => setHovered((current) => (current === cell.name ? null : current))}
                    >
                      <span className={styles.cellName}>{cell.name}</span>
                      <span className={styles.cellBar} aria-hidden="true">
                        {empty
                          ? null
                          : data.freq.map((freq, a) =>
                              freq > 0 ? <span key={a} className={classes[a]} style={{ inlineSize: `${freq * 100}%` }} /> : null,
                            )}
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div className={styles.chartDetail} aria-live="polite">
          {detail && shown ? (
            <>
              <p className={styles.chartDetailHead}>
                <strong>{shown}</strong>
                {shown === study.heroClass ? <span className={styles.tag}>{t.yourHand}</span> : null}
              </p>
              <p className={styles.muted}>{detail.combos > 0 ? t.detailCombos(detail.combos) : t.notInRange}</p>
              {detail.combos > 0 ? (
                <ul className={styles.detailList}>
                  {study.options.map((_, a) => (
                    <li key={a}>
                      <span className={`${styles.swatch} ${classes[a]}`} aria-hidden="true" />
                      <span>{labels[a]}</span>
                      <span className={styles.num}>{t.freq(detail.freq[a])}</span>
                      <span className={styles.num}>{t.signedBb(detail.ev[a])}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {shown === study.heroClass ? (
                <>
                  <p className={styles.muted}>{t.yourCombo(study.heroCombo)}</p>
                  <ul className={styles.detailList}>
                    {study.options.map((_, a) => (
                      <li key={a}>
                        <span className={`${styles.swatch} ${classes[a]}`} aria-hidden="true" />
                        <span>{labels[a]}</span>
                        <span className={styles.num}>{t.freq(study.hero.freq[a])}</span>
                        <span className={styles.num}>{t.signedBb(study.hero.ev[a])}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </>
          ) : (
            <p className={styles.muted}>{t.detailEmpty}</p>
          )}
        </div>
      </div>
    </div>
  );
}
