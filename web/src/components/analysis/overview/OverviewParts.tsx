/**
 * The Analysis overview's parts (redesign of 2026-11, "AN-Overview" on the
 * map canvas): the headline figures with the grade bar, the heatmap of where
 * the EV goes, the hands, and the side column's top leaks and training.
 *
 * Few words: the reader is an advanced player. Every interactive part filters
 * the hands list through the address bar's list state, so Back from a hand
 * still lands on the same list.
 */

"use client";

import { CardRow } from "@rail/ui/cards/PlayingCard";
import type { GameKind } from "@rail/ui/hands/gameKind";
import { RailLoader } from "@rail/ui/loader/RailLoader";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { GRADES, FLAG_CODES } from "../../../lib/analysis/types";
import { leakKind, groupLeaks } from "../../../lib/analysis/leaks";
import { rankTopLeaks } from "../../../lib/analysis/topLeaks";
import {
  fetchAnalysisBreakdown,
  fetchAnalysisHands,
  fetchAnalysisOverview,
  type AnalysisBreakdownRow,
  type AnalysisHandRow,
  type AnalysisOverview,
  type AnalysisSort,
  type GradeCounts,
} from "../../../lib/db/analysis";
import { fetchStudyPlan, type StoredPlan } from "../../../lib/db/studyPlan";
import { fetchTopLeaks } from "../../../lib/db/topLeaks";
import { fetchDrillSummary, type DrillSummary } from "../../../lib/db/training";
import { useDict } from "../../../lib/i18n/client";
import { getParser } from "../../../lib/phf";
import { paths } from "../../../lib/routes";
import { planProgress, weekBounds, weekStart } from "../../../lib/training/plan";
import { dateFormat, numberFormat, useIntlLocale } from "../../stats/format";
import { ActionStrip } from "../ActionStrip";
import { EMPTY_LEAKS_STATE, leaksQuery } from "../leaks/leaksState";
import { listFilters, listQuery, POSITION_VALUES, POT_VALUES, STREET_VALUES, type AnalysisListState } from "../listState";
import { DEFAULT_TRAIN_STATE, trainQuery } from "../train/trainState";
import styles from "../ui/an.module.css";

type Grade = (typeof GRADES)[number];
const PAGE_SIZE = 25;

export function countsOf(rows: Array<{ grade: string; decisions: number }>): GradeCounts {
  const counts: GradeCounts = { perfect: 0, good: 0, inaccurate: 0, mistake: 0, blunder: 0 };
  for (const row of rows) {
    if (row.grade in counts) counts[row.grade as keyof GradeCounts] += row.decisions;
  }
  return counts;
}

/* ------------------------------------------------------------- headline - */

/** Score, EV lost per 100 hands, mistake rate and moves graded; the grade bar filters the hands. */
export function OverviewHead({
  overview,
  grade,
  onGrade,
}: {
  overview: AnalysisOverview;
  grade: string | null;
  onGrade: (grade: string | null) => void;
}) {
  const en = useDict().analysis;
  const t = en.ui;
  const locale = useIntlLocale();
  const fixed1 = numberFormat(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  const fixed2 = numberFormat(locale, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  const count = numberFormat(locale, { maximumFractionDigits: 0 });
  const pct = numberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  const counts = countsOf(overview.grades);
  const graded = overview.graded;
  const per100 = overview.gradedHands > 0 && overview.evLossBb !== null ? (overview.evLossBb / overview.gradedHands) * 100 : null;
  const mistakeRate = graded > 0 ? (counts.mistake + counts.blunder) / graded : null;
  const filtering = grade !== null && (GRADES as readonly string[]).includes(grade);

  return (
    <section className={styles.card}>
      <div className={styles.kpis}>
        <dl className={styles.kpi}>
          <dt>{t.kpi.score}</dt>
          <dd>
            {overview.score === null ? "—" : fixed1.format(overview.score)}
            <span className={styles.unit}>{t.kpi.outOf}</span>
          </dd>
        </dl>
        <dl className={styles.kpi}>
          <dt>{t.kpi.evLost}</dt>
          <dd className={per100 ? styles.neg : undefined}>
            {per100 === null ? "—" : `−${fixed2.format(per100)}`}
            <span className={styles.unit}>{t.kpi.per100}</span>
          </dd>
        </dl>
        <dl className={styles.kpi}>
          <dt>{t.kpi.mistakes}</dt>
          <dd>{mistakeRate === null ? "—" : pct.format(mistakeRate)}</dd>
        </dl>
        <dl className={styles.kpi}>
          <dt>{t.kpi.graded}</dt>
          <dd>
            {count.format(graded)}
            <span className={styles.unit}>{t.kpi.gradedOf(overview.gradedHands)}</span>
          </dd>
        </dl>

        {graded > 0 ? (
          <div className={styles.gradeBox}>
            <div className={`${styles.cardHead} ${styles.xs} ${styles.dim}`} style={{ minBlockSize: 0 }}>
              <span>{t.grades.label}</span>
              <span className={styles.grow} />
              {filtering ? (
                <button type="button" className={styles.linkBtn} onClick={() => onGrade(null)}>
                  {t.grades.clear}
                </button>
              ) : null}
            </div>
            <div className={`${styles.gradeBar} ${filtering ? styles.gradeBarDim : ""}`} role="group" aria-label={t.grades.label}>
              {GRADES.map((g) =>
                counts[g] > 0 ? (
                  <button
                    key={g}
                    type="button"
                    className={styles[`g_${g}`]}
                    style={{ flex: `${counts[g]} 1 0` }}
                    aria-pressed={grade === g}
                    aria-label={t.grades.filter(en.grades[g] ?? g, pct.format(counts[g] / graded))}
                    onClick={() => onGrade(grade === g ? null : g)}
                  />
                ) : null,
              )}
            </div>
            <div className={styles.gradeKeys}>
              {GRADES.map((g) => (
                <button
                  key={g}
                  type="button"
                  className={styles.gradeKey}
                  data-off={filtering && grade !== g}
                  aria-pressed={grade === g}
                  onClick={() => onGrade(grade === g ? null : g)}
                >
                  <i className={`${styles.dot} ${styles[`g_${g}`]}`} aria-hidden="true" />
                  {en.grades[g]} <span className={styles.dim}>{pct.format(counts[g] / graded)}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- heatmap - */

type Axis = "position" | "pot_type";
type Metric = "ev" | "score" | "mistakes";

interface HeatLoaded {
  key: string;
  gradedHands: number;
  /** row key (seat or pot type) → that row's decisions, by street. */
  byRow: Record<string, AnalysisBreakdownRow[]>;
}

/**
 * Seat (or pot type) × street. Its own scope is the kind of game only: a cell
 * picks a seat and a street for the rest of the screen, so the map itself
 * must not shrink to that one row.
 *
 * Each row is the street breakdown filtered to that seat (or pot type): the
 * per-decision summaries answer that directly. A street *filter* would not —
 * it narrows to hands that reached the street and sums their whole EV loss.
 */
export function EvHeatmap({
  kind,
  generation,
  position,
  potType,
  street,
  onPick,
}: {
  kind: GameKind | null;
  generation: number;
  position: string | null;
  potType: string | null;
  street: string | null;
  onPick: (patch: Partial<AnalysisListState>) => void;
}) {
  const en = useDict();
  const t = en.analysis.ui.heat;
  const locale = useIntlLocale();
  const fixed2 = numberFormat(locale, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  const count = numberFormat(locale, { maximumFractionDigits: 0 });
  const pct = numberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  const [axis, setAxis] = useState<Axis>(potType && !position ? "pot_type" : "position");
  const [metric, setMetric] = useState<Metric>("ev");
  const [loaded, setLoaded] = useState<HeatLoaded | null>(null);
  const requestKey = `${kind ?? ""}|${axis}|${generation}`;

  useEffect(() => {
    let live = true;
    const scope = kind ? { gameKind: kind } : {};
    (async () => {
      const [overview, groups] = await Promise.all([fetchAnalysisOverview(scope), fetchAnalysisBreakdown(scope, axis)]);
      const keys = groups.filter((row) => row.key && row.graded > 0).map((row) => row.key as string);
      const perRow = await Promise.all(
        keys.map((key) => fetchAnalysisBreakdown({ ...scope, ...(axis === "position" ? { position: key } : { potType: key }) }, "street")),
      );
      if (!live) return;
      const byRow: Record<string, AnalysisBreakdownRow[]> = {};
      keys.forEach((key, i) => {
        byRow[key] = perRow[i] ?? [];
      });
      setLoaded({ key: requestKey, gradedHands: overview?.gradedHands ?? 0, byRow });
    })().catch(() => {
      if (live) setLoaded({ key: requestKey, gradedHands: 0, byRow: {} });
    });
    return () => {
      live = false;
    };
  }, [axis, kind, requestKey]);

  const order: readonly string[] = axis === "position" ? POSITION_VALUES : POT_VALUES;
  const rows = useMemo(() => (loaded ? order.filter((key) => key in loaded.byRow) : []), [loaded, order]);

  const cellOf = (row: string, s: string) => (loaded?.byRow[row] ?? []).find((r) => r.key === s) ?? null;
  const evOf = (r: AnalysisBreakdownRow | null) =>
    r && r.evLossBb !== null && loaded && loaded.gradedHands > 0 ? (r.evLossBb / loaded.gradedHands) * 100 : null;
  const mistakesOf = (r: AnalysisBreakdownRow | null) => (r && r.graded > 0 ? (r.grades.mistake + r.grades.blunder) / r.graded : null);
  const maxEv = Math.max(0.0001, ...rows.flatMap((row) => STREET_VALUES.map((s) => evOf(cellOf(row, s)) ?? 0)));
  const maxMistakes = Math.max(0.0001, ...rows.flatMap((row) => STREET_VALUES.map((s) => mistakesOf(cellOf(row, s)) ?? 0)));
  const rowLabel = (key: string) => (axis === "position" ? key : (en.stats.breakdown.potTypes[key] ?? key));

  const intensity = (r: AnalysisBreakdownRow | null): number | null => {
    if (!r || r.graded === 0) return null;
    if (metric === "ev") return (evOf(r) ?? 0) / maxEv;
    if (metric === "mistakes") return (mistakesOf(r) ?? 0) / maxMistakes;
    return r.score === null ? null : Math.max(0, Math.min(1, (90 - r.score) / 40));
  };

  return (
    <section className={styles.card}>
      <div className={styles.cardHead}>
        <h3 className={styles.ttl}>{t.title}</h3>
        <span className={styles.grow} />
        <div className={styles.seg} role="group" aria-label={t.rows.position}>
          <button type="button" aria-pressed={axis === "position"} onClick={() => setAxis("position")}>
            {t.rows.position}
          </button>
          <button type="button" aria-pressed={axis === "pot_type"} onClick={() => setAxis("pot_type")}>
            {t.rows.pot}
          </button>
        </div>
        <div className={styles.seg} role="group" aria-label={t.metrics.ev}>
          {(["ev", "score", "mistakes"] as const).map((m) => (
            <button key={m} type="button" aria-pressed={metric === m} onClick={() => setMetric(m)}>
              {t.metrics[m]}
            </button>
          ))}
        </div>
      </div>

      {!loaded || loaded.key !== requestKey ? (
        <RailLoader label={t.title} centered />
      ) : rows.length === 0 ? (
        <p className={styles.empty}>{t.none}</p>
      ) : (
        <div className={styles.heat}>
          <div className={styles.heatRow}>
            <span />
            {STREET_VALUES.map((s) => (
              <span key={s} className={styles.heatLabel}>
                {en.analysis.streets[s]}
              </span>
            ))}
          </div>
          {rows.map((row) => (
            <div key={row} className={styles.heatRow}>
              <span className={styles.heatLabel}>{rowLabel(row)}</span>
              {STREET_VALUES.map((s) => {
                const r = cellOf(row, s);
                const k = intensity(r);
                const ev = evOf(r);
                const mistakes = mistakesOf(r);
                const selected = street === s && (axis === "position" ? position === row : potType === row);
                const text =
                  !r || r.graded === 0
                    ? "—"
                    : metric === "ev"
                      ? ev === null
                        ? "—"
                        : `−${fixed2.format(ev)}`
                      : metric === "score"
                        ? r.score === null
                          ? "—"
                          : count.format(r.score)
                        : mistakes === null
                          ? "—"
                          : pct.format(mistakes);
                return (
                  <button
                    key={s}
                    type="button"
                    className={styles.cell}
                    disabled={k === null}
                    aria-pressed={selected}
                    title={
                      r && r.graded > 0
                        ? t.cell(
                            rowLabel(row),
                            en.analysis.streets[s] ?? s,
                            ev === null ? "—" : fixed2.format(ev),
                            r.score === null ? "—" : count.format(r.score),
                            mistakes === null ? "—" : pct.format(mistakes),
                            r.graded,
                          )
                        : undefined
                    }
                    style={{
                      background:
                        k === null
                          ? "var(--surface-inset)"
                          : `color-mix(in srgb, var(--loss-fg) ${Math.round(8 + k * 72)}%, var(--surface-inset))`,
                    }}
                    onClick={() =>
                      onPick(
                        selected
                          ? { street: null, ...(axis === "position" ? { position: null } : { potType: null }), page: 0 }
                          : { street: s, ...(axis === "position" ? { position: row } : { potType: row }), page: 0 },
                      )
                    }
                  >
                    {text}
                    {r && r.graded > 0 ? <small>{t.decisions(r.graded)}</small> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
      <div className={`${styles.cardHead} ${styles.xs} ${styles.dim}`} style={{ minBlockSize: 0 }}>
        <span>{t.low}</span>
        <span className={styles.scale} aria-hidden="true" />
        <span>{t.high}</span>
        <span className={styles.grow} />
        <span>{t.hint}</span>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- hands - */

function gradeOf(row: AnalysisHandRow): Grade | null {
  return row.grade && (GRADES as readonly string[]).includes(row.grade) ? (row.grade as Grade) : null;
}

/** The hands, filtered by everything above; each row opens the hand. */
export function HandsList({
  state,
  onChange,
  generation,
  flags,
}: {
  state: AnalysisListState;
  onChange: (patch: Partial<AnalysisListState>) => void;
  generation: number;
  flags: AnalysisOverview["flags"];
}) {
  const en = useDict();
  const t = en.analysis;
  const ui = t.ui.hands;
  const locale = useIntlLocale();
  const [rows, setRows] = useState<AnalysisHandRow[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const filterKey = JSON.stringify(listFilters(state));
  const query = listQuery(state);
  const requestKey = `${filterKey}|${state.sort}|${state.page}|${generation}`;
  const [answeredKey, setAnsweredKey] = useState<string | null>(null);
  const loading = answeredKey !== requestKey;

  useEffect(() => {
    let live = true;
    fetchAnalysisHands(JSON.parse(filterKey), state.sort, PAGE_SIZE, state.page * PAGE_SIZE)
      .then((result) => {
        if (!live) return;
        setRows(result.rows);
        setTotal(result.total);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (live) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (live) setAnsweredKey(requestKey);
      });
    return () => {
      live = false;
    };
  }, [filterKey, state.sort, state.page, requestKey]);

  const when = (iso: string | null) =>
    iso ? dateFormat(locale, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : "—";
  const signed = numberFormat(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1, signDisplay: "exceptZero" });
  const fixed2 = numberFormat(locale, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  const from = total === 0 ? 0 : state.page * PAGE_SIZE + 1;
  const to = Math.min(total, (state.page + 1) * PAGE_SIZE);

  // The three most common flags as one-click filters; the rest under "More filters".
  const topFlags = useMemo(() => {
    const byCode = new Map<string, number>();
    for (const flag of flags) byCode.set(flag.code, (byCode.get(flag.code) ?? 0) + flag.count);
    return [...byCode.entries()]
      .filter(([code]) => (FLAG_CODES as readonly string[]).includes(code))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
  }, [flags]);
  const [more, setMore] = useState(Boolean(state.status || state.street));
  const filtered = state.street || state.flag || state.status || state.grade || state.position || state.potType;
  const sortBtn = (sort: AnalysisSort, label: string) => (
    <button type="button" aria-pressed={state.sort === sort} onClick={() => onChange({ sort, page: 0 })}>
      {label}
      {state.sort === sort ? " ↓" : ""}
    </button>
  );

  return (
    <section className={`${styles.card} ${styles.flush} ${styles.listBox}`} id="analysis-hands">
      <div className={styles.cardHead}>
        <h3 className={styles.ttl}>{ui.title}</h3>
        <span className={`${styles.xs} ${styles.dim}`}>{ui.count(total)}</span>
        {loading && answeredKey !== null ? <RailLoader size="inline" label={t.list.loading} /> : null}
        {filtered ? (
          <button
            type="button"
            className={styles.chip}
            aria-pressed="true"
            onClick={() => onChange({ street: null, flag: null, status: null, grade: null, position: null, potType: null, page: 0 })}
          >
            {[
              state.position,
              state.potType ? (en.stats.breakdown.potTypes[state.potType] ?? state.potType) : null,
              state.street ? t.streets[state.street] : null,
              state.grade ? (state.grade === "bad" ? t.filters.badGrades : t.grades[state.grade]) : null,
              state.flag ? (state.flag === "any" ? t.filters.flaggedOnly : t.flags[state.flag as keyof typeof t.flags]) : null,
            ]
              .filter(Boolean)
              .join(" · ")}{" "}
            ✕
          </button>
        ) : null}
        <span className={styles.grow} />
        {topFlags.map(([code, n]) => (
          <button
            key={code}
            type="button"
            className={styles.chip}
            aria-pressed={state.flag === code}
            onClick={() => onChange({ flag: state.flag === code ? null : code, page: 0 })}
          >
            {t.flags[code as keyof typeof t.flags] ?? code} <span className={styles.dim}>{n}</span>
          </button>
        ))}
        <button type="button" className={styles.chip} aria-expanded={more} onClick={() => setMore(!more)}>
          {ui.more}
        </button>
      </div>

      {more ? (
        <div className={styles.cardHead} style={{ paddingBlockStart: 0 }}>
          <label className={styles.dd}>
            {t.filters.street}
            <select value={state.street ?? ""} onChange={(e) => onChange({ street: e.target.value || null, page: 0 })}>
              <option value="">{t.ui.scope.any}</option>
              {STREET_VALUES.map((s) => (
                <option key={s} value={s}>
                  {t.streets[s]}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.dd}>
            {t.filters.flag}
            <select value={state.flag ?? ""} onChange={(e) => onChange({ flag: e.target.value || null, page: 0 })}>
              <option value="">{t.ui.scope.any}</option>
              <option value="any">{t.filters.flaggedOnly}</option>
              {FLAG_CODES.map((code) => (
                <option key={code} value={code}>
                  {t.flags[code]}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.dd}>
            {t.filters.grade}
            <select value={state.grade ?? ""} onChange={(e) => onChange({ grade: e.target.value || null, page: 0 })}>
              <option value="">{t.ui.scope.any}</option>
              <option value="bad">{t.filters.badGrades}</option>
              {GRADES.map((g) => (
                <option key={g} value={g}>
                  {t.grades[g]}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.dd}>
            {t.filters.status}
            <select value={state.status ?? ""} onChange={(e) => onChange({ status: e.target.value || null, page: 0 })}>
              <option value="">{t.ui.scope.any}</option>
              <option value="full">{t.overview.full.label}</option>
              <option value="partial">{t.overview.partial.label}</option>
              <option value="not-analysed">{t.overview.notAnalysed.label}</option>
            </select>
          </label>
          <label className={styles.dd}>
            {t.filters.sort}
            <select value={state.sort} onChange={(e) => onChange({ sort: e.target.value as AnalysisSort, page: 0 })}>
              {(["recent", "oldest", "flags", "ev_loss", "ev_loss_pot", "score", "result"] as const).map((sort) => (
                <option key={sort} value={sort}>
                  {t.filters.sorts[sort]}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}

      {error ? <p className="notice notice--error">{error}</p> : null}

      <div className={styles.listHead} aria-hidden="true">
        <span>{ui.cols.hand}</span>
        <span>{ui.cols.pos}</span>
        <span className={styles.hideMid}>{ui.cols.spot}</span>
        <span>{ui.cols.line}</span>
        <span>{ui.cols.worst}</span>
        {sortBtn("ev_loss", ui.cols.evLost)}
        {sortBtn("result", ui.cols.result)}
        <span className={styles.hideMid} style={{ justifySelf: "end" }}>
          {sortBtn("recent", ui.cols.when)}
        </span>
      </div>

      {answeredKey === null ? (
        <RailLoader label={t.list.loading} showLabel centered />
      ) : !loading && rows.length === 0 ? (
        <div className={styles.empty}>
          {ui.empty}{" "}
          {filtered ? (
            <button
              type="button"
              className={styles.linkBtn}
              onClick={() => onChange({ street: null, flag: null, status: null, grade: null, position: null, potType: null, page: 0 })}
            >
              {ui.clear}
            </button>
          ) : null}
        </div>
      ) : (
        <div aria-busy={loading} className="rail-dims">
          {rows.map((row) => {
            const g = gradeOf(row);
            const cards = row.heroCards.join(" ");
            return (
              <Link
                key={row.handId}
                href={paths.analysisHand(row.handId, query)}
                className={styles.hrow}
                aria-label={t.list.open(cards || row.handClass || row.handId)}
              >
                <span>{row.heroCards.length ? <CardRow cards={row.heroCards} size="xs" /> : (row.handClass ?? "—")}</span>
                <span className={styles.posTag}>{row.position ?? "—"}</span>
                <span className={`${styles.ellipsis} ${styles.muted} ${styles.xs} ${styles.hideMid}`}>
                  {row.potType ? (en.stats.breakdown.potTypes[row.potType] ?? row.potType) : "—"}
                  {" · "}
                  {getParser(row.site)?.name ?? row.site}
                  {row.stakesLabel ? ` ${row.stakesLabel}` : ""}
                </span>
                <span className={styles.hideNarrow}>
                  {row.status === "not-analysed" ? (
                    <span className={`${styles.xs} ${styles.dim}`}>{t.reasons[row.reason ?? ""] ?? row.reason}</span>
                  ) : (
                    <ActionStrip decisions={row.decisions} />
                  )}
                </span>
                <span className={`${styles.grade} ${styles.hideNarrow} ${g ? styles[`t_${g}`] : styles.dim}`}>
                  {g ? <i className={`${styles.dot} ${styles[`g_${g}`]}`} aria-hidden="true" /> : null}
                  {g ? t.grades[g] : "—"}
                </span>
                <span className={`${styles.r} ${styles.hideNarrow} ${row.evLossBb ? styles.neg : styles.dim}`}>
                  {row.evLossBb === null ? "—" : row.evLossBb > 0 ? `−${fixed2.format(row.evLossBb)}` : fixed2.format(0)}
                </span>
                <span className={`${styles.r} ${row.netBb === null ? styles.dim : row.netBb >= 0 ? styles.pos : styles.neg}`}>
                  {row.netBb === null ? "—" : en.stats.common.bb(signed.format(row.netBb))}
                </span>
                <span className={`${styles.r} ${styles.xs} ${styles.dim} ${styles.hideMid}`}>{when(row.playedAt)}</span>
              </Link>
            );
          })}
        </div>
      )}

      {total > PAGE_SIZE ? (
        <div className={styles.pager}>
          <button type="button" className="btn btn--ghost btn--sm" disabled={state.page === 0} onClick={() => onChange({ page: Math.max(0, state.page - 1) })}>
            {t.list.previous}
          </button>
          <span className={`${styles.xs} ${styles.muted}`}>{t.list.page(from, to, total)}</span>
          <button type="button" className="btn btn--ghost btn--sm" disabled={to >= total} onClick={() => onChange({ page: state.page + 1 })}>
            {t.list.next}
          </button>
        </div>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------ side cards - */

/** The three costliest leaks of the last 30 days, as bars; each opens Leaks. */
export function TopLeaksMini({ scopeKey, generation }: { scopeKey: string; generation: number }) {
  const en = useDict().analysis;
  const t = en.ui.side;
  const locale = useIntlLocale();
  const fixed2 = numberFormat(locale, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  const [top, setTop] = useState<ReturnType<typeof rankTopLeaks> | null>(null);

  useEffect(() => {
    let live = true;
    fetchTopLeaks(JSON.parse(scopeKey), "30d")
      .then((report) => {
        if (!live) return;
        setTop(report ? rankTopLeaks(groupLeaks(report.sample.rows, { hands: report.sample.hands })) : []);
      })
      .catch(() => {
        if (live) setTop([]);
      });
    return () => {
      live = false;
    };
  }, [scopeKey, generation]);

  if (!top || top.length === 0) return null;
  const max = Math.max(0.0001, ...top.map((entry) => entry.leak.per100));
  const level = { low: 1, medium: 2, high: 3 } as const;
  return (
    <section className={styles.card}>
      <div className={styles.cardHead}>
        <h3 className={styles.ttl}>{t.topLeaks}</h3>
        <span className={styles.grow} />
        <Link href={paths.analysisLeaks()} className={`${styles.xs}`} style={{ color: "var(--text-link)" }}>
          {t.allLeaks}
        </Link>
      </div>
      {top.map(({ leak, rank }) => {
        const title = en.leaks.title(leakKind(leak.attrs.taken, leak.attrs.best), leak.attrs);
        const context = en.leaks.fullContext(leak.attrs, leak.level, leak.partial);
        return (
          <Link key={leak.id} href={paths.analysisLeaks(leaksQuery({ ...EMPTY_LEAKS_STATE, leak: leak.id }))} className={styles.lrow}>
            <span className={styles.lline}>
              <span className={`${styles.xs} ${styles.dim}`} style={{ inlineSize: 14 }}>
                {rank}
              </span>
              <span className={`${styles.strong} ${styles.ellipsis}`} style={{ flex: 1 }}>
                {title}
              </span>
              <span className={`${styles.neg} ${styles.strong}`}>−{fixed2.format(leak.per100)}</span>
            </span>
            <span className={styles.lline} style={{ paddingInlineStart: 22 }}>
              <span className={`${styles.xs} ${styles.dim} ${styles.ellipsis}`} style={{ flex: 1 }}>
                {context} · {en.leaks.streets[leak.attrs.street] ?? leak.attrs.street}
              </span>
              <span className={styles.conf} aria-label={en.leaks.confidence[leak.confidence]} title={en.leaks.confidence[leak.confidence]}>
                {[1, 2, 3].map((n) => (
                  <i key={n} data-on={n <= level[leak.confidence]} />
                ))}
              </span>
            </span>
            <span className={styles.hbar} style={{ marginInlineStart: 22 }}>
              <i style={{ inlineSize: `${(leak.per100 / max) * 100}%` }} />
            </span>
          </Link>
        );
      })}
    </section>
  );
}

/** Drills due and this week's plan, in one card. */
export function TrainMini({ kind, generation }: { kind: GameKind | null; generation: number }) {
  const en = useDict().analysis;
  const t = en.ui.side;
  const [drills, setDrills] = useState<DrillSummary | null>(null);
  const [plan, setPlan] = useState<StoredPlan | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    if (kind) {
      fetchDrillSummary(kind)
        .then((value) => {
          if (live) setDrills(value);
        })
        .catch(() => {
          if (live) setDrills(null);
        });
    }
    const week = weekStart(new Date());
    fetchStudyPlan(week, weekBounds(week).from)
      .then((value) => {
        if (live) setPlan(value);
      })
      .catch(() => {
        if (live) setPlan(null);
      });
    return () => {
      live = false;
    };
  }, [kind, generation]);

  const due = drills ? drills.due + drills.candidates : 0;
  const progress = plan ? planProgress(plan.tasks) : null;
  const trainHref = kind ? paths.analysisTrain(trainQuery({ ...DEFAULT_TRAIN_STATE, mode: "drills", kind })) : paths.analysisTrain();
  return (
    <section className={styles.card}>
      <div className={styles.cardHead} style={{ alignItems: "flex-end" }}>
        <dl className={styles.kpi}>
          <dt>{t.drills}</dt>
          <dd>
            {due}
            <span className={styles.unit}>{t.now}</span>
          </dd>
        </dl>
        <span className={styles.grow} />
        <Link href={trainHref} className="btn btn--primary btn--sm">
          {t.train}
        </Link>
      </div>
      {progress ? (
        <Link href={paths.analysisPlan()} className={styles.lrow} style={{ padding: 0 }}>
          <span className={`${styles.lline} ${styles.xs} ${styles.dim}`}>
            <span>{t.week}</span>
            <span className={styles.grow} />
            <span>{t.tasks(progress.done, progress.total)}</span>
          </span>
          <span className={styles.mbar}>
            <i style={{ inlineSize: `${Math.round(Math.min(1, progress.share) * 100)}%` }} />
          </span>
        </Link>
      ) : plan === null ? (
        <Link href={paths.analysisPlan()} className={styles.xs} style={{ color: "var(--text-link)" }}>
          {t.buildPlan}
        </Link>
      ) : null}
    </section>
  );
}

