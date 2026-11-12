/**
 * The Ranges tab of a decision: both players' ranges side by side, the way a
 * solver's viewer compares them.
 *
 * ```
 * out of position's grid │ both ranges: combos, EV, equity, EQR, │ in position's grid
 * (strategy, EV, equity, │ then made hands / draws / equity      │ (EV, equity, range, EQR)
 *  range or EQR)         │ buckets, each player's share          │
 * ─────────────────────────────────────────────────────────────────────────────────
 * the equity chart: every combo of each range, weakest first, across the share of the range
 * ```
 *
 * Each cell draws its combos as columns, as tall as the combo's reach and
 * coloured by the picked measure (red low, green high), so a class's spread
 * shows; the strategy view is the Strategy tab's cell. Everything counts only
 * the combos that pass the hand filter (`masks`); the chart marks them.
 */

"use client";

import { useMemo, useState, type ReactNode } from "react";
import { RailLoader } from "@rail/ui/loader/RailLoader";
import { useSolverDict, type SolverDict } from "./host";
import { DRAWS, EQ_BANDS, EQ_BUCKETS, filterId, MADE_HANDS, comboIds, type FilterGroup } from "../../lib/solver";
import { GRID_CELLS } from "../analysis/chartSpots";
import analysis from "../analysis/analysis.module.css";
import { filterLabel } from "./HandFilters";
import type { RangeData } from "./rangeData";
import type { StrategyModel } from "./StrategyView";
import styles from "./solver.module.css";

type Pair<T> = [T, T];
type Mode = "strategy" | "ev" | "equity" | "range" | "eqr";
const MODES: Mode[] = ["strategy", "ev", "equity", "range", "eqr"];
type Group = Exclude<FilterGroup, "suit">;
const GROUPS: Array<{ group: Group; values: readonly string[] }> = [
  { group: "made", values: MADE_HANDS },
  { group: "draw", values: DRAWS },
  { group: "eq", values: EQ_BUCKETS },
  { group: "band", values: EQ_BANDS },
];
/** EQR at which a cell is fully green. */
const EQR_TOP = 1.5;

/** Red (0) through yellow to green (1). */
function heat(t: number): string {
  const x = Math.max(0, Math.min(1, t));
  return `hsl(${Math.round(x * 120)} 62% 42%)`;
}

interface SideView {
  reach: Float64Array;
  /** Reach summed, the filter applied and not. */
  combos: number;
  full: number;
  ev: number | null;
  equity: number | null;
  eqr: number | null;
  /** Share of the (filtered) reach per filter id. */
  shares: Map<string, number>;
}

function sideView(data: RangeData, p: 0 | 1, mask: Uint8Array | null): SideView {
  const side = data.ranges.sides[p];
  const eq = data.equity?.[p] ?? null;
  const reach = Float64Array.from(side.reach, (r, i) => (mask && !mask[i] ? 0 : r));
  let combos = 0;
  let full = 0;
  let ev = 0;
  let eqSum = 0;
  let eqWeight = 0;
  const shares = new Map<string, number>();
  side.reach.forEach((r) => {
    full += r;
  });
  reach.forEach((r, i) => {
    if (r <= 0) return;
    combos += r;
    if (side.ev) ev += r * side.ev[i];
    const e = eq ? eq[i] : Number.NaN;
    if (!Number.isNaN(e)) {
      eqSum += r * e;
      eqWeight += r;
    }
    for (const id of comboIds(data.cards[p][i], data.features[p][i], e)) shares.set(id, (shares.get(id) ?? 0) + r);
  });
  for (const [id, v] of shares) shares.set(id, combos > 0 ? v / combos : 0);
  const meanEv = side.ev && combos > 0 ? ev / combos : null;
  const meanEq = eq && eqWeight > 0 ? eqSum / eqWeight : null;
  const pot = data.ranges.pot;
  return {
    reach,
    combos,
    full,
    ev: meanEv,
    equity: meanEq,
    eqr: meanEv !== null && meanEq ? meanEv / (meanEq * pot) : null,
    shares,
  };
}

export function RangesView({ data, masks, strategy }: { data: RangeData; masks: Pair<Uint8Array> | null; strategy: StrategyModel }) {
  const t = useSolverDict();
  // By role, not by seat: the player to act opens on the strategy, the other on EV.
  const [modes, setModes] = useState<{ actor: Mode; other: Mode }>({ actor: "strategy", other: "ev" });
  const [group, setGroup] = useState<Group>("made");
  const [hover, setHover] = useState<{ p: 0 | 1; k: number } | null>(null);
  const { ranges } = data;
  const views = useMemo(
    () => [sideView(data, 0, masks?.[0] ?? null), sideView(data, 1, masks?.[1] ?? null)] as Pair<SideView>,
    [data, masks],
  );
  const river = ranges.board.length >= 5;
  const groups = GROUPS.filter((g) => !(river && g.group === "draw") && (data.equity || (g.group !== "eq" && g.group !== "band")));
  const shownGroup: Group = groups.some((g) => g.group === group) ? group : "made";
  const role = (p: 0 | 1) => (p === ranges.actor ? "actor" : "other");
  const modeOf = (p: 0 | 1): Mode => {
    const mode = modes[role(p)];
    return (mode === "ev" || mode === "eqr") && !ranges.sides[p].ev ? "equity" : mode;
  };

  // Equity is worked out a moment after the click: the inline loader until then.
  const equityLoading = <RailLoader size="inline" label={t.ranges.equityLoading} />;
  const rows: Array<{ label: string; left: ReactNode; right: ReactNode; a: number; b: number; note?: string }> = [
    {
      label: t.ranges.combos,
      left: t.ranges.cellValue.range(views[0].combos),
      right: t.ranges.cellValue.range(views[1].combos),
      a: views[0].combos,
      b: views[1].combos,
      note: masks ? `${t.ranges.share(views[0].full > 0 ? views[0].combos / views[0].full : 0)} · ${t.ranges.share(views[1].full > 0 ? views[1].combos / views[1].full : 0)}` : undefined,
    },
    {
      label: t.ranges.ev,
      left: views[0].ev === null ? t.ranges.noEv : t.ranges.bb(views[0].ev),
      right: views[1].ev === null ? t.ranges.noEv : t.ranges.bb(views[1].ev),
      a: views[0].ev ?? 0,
      b: views[1].ev ?? 0,
      note:
        views[0].ev !== null && views[1].ev !== null
          ? `${t.ranges.share(views[0].ev / ranges.pot)} · ${t.ranges.share(views[1].ev / ranges.pot)}`
          : undefined,
    },
    {
      label: t.ranges.equity,
      left: views[0].equity === null ? equityLoading : t.ranges.share(views[0].equity),
      right: views[1].equity === null ? equityLoading : t.ranges.share(views[1].equity),
      a: views[0].equity ?? 0,
      b: views[1].equity ?? 0,
    },
    {
      label: t.ranges.eqr,
      left: views[0].eqr === null ? t.ranges.noEv : t.ranges.eqrValue(views[0].eqr),
      right: views[1].eqr === null ? t.ranges.noEv : t.ranges.eqrValue(views[1].eqr),
      a: views[0].eqr ?? 0,
      b: views[1].eqr ?? 0,
    },
  ];
  const groupValues = GROUPS.find((g) => g.group === shownGroup)!.values;
  const categories = groupValues
    .map((value) => filterId(shownGroup, value))
    .map((id) => ({ id, a: views[0].shares.get(id) ?? 0, b: views[1].shares.get(id) ?? 0 }))
    .filter((row) => row.a > 0 || row.b > 0);

  const hovered = hover ? hoverLine(data, views, hover.p, hover.k, t) : null;
  const missingEv = ranges.sides.find((side) => !side.ev);

  return (
    <div className={styles.ranges}>
      <div className={styles.rangesTop}>
        {([0, 1] as const).map((p) => (
          <div key={p} className={styles.rangeSide} style={{ order: p === 0 ? 0 : 2 }}>
            <div className={styles.rangeHead}>
              <strong>
                {ranges.sides[p].position}
                {p === ranges.actor ? <span className={styles.toAct}> · {t.preflop.toAct}</span> : null}
              </strong>
              <select
                className={styles.modeSelect}
                aria-label={t.ranges.mode(ranges.sides[p].position)}
                value={modeOf(p)}
                onChange={(event) => setModes((m) => ({ ...m, [role(p)]: event.target.value as Mode }))}
              >
                {MODES.filter((m) => m !== "strategy" || p === ranges.actor).map((m) => (
                  <option key={m} value={m} disabled={(m === "ev" || m === "eqr") && !ranges.sides[p].ev}>
                    {t.ranges.modes[m]}
                  </option>
                ))}
              </select>
            </div>
            <RangeGrid data={data} view={views[p]} p={p} mode={modeOf(p)} strategy={strategy} onHover={(k) => setHover(k === null ? null : { p, k })} />
          </div>
        ))}

        <section className={styles.compare} aria-label={t.ranges.compare} style={{ order: 1 }}>
          {rows.map((row) => (
            <CompareRow key={row.label} {...row} />
          ))}
          <select className={styles.modeSelect} aria-label={t.ranges.groupPick} value={shownGroup} onChange={(event) => setGroup(event.target.value as Group)}>
            {groups.map((g) => (
              <option key={g.group} value={g.group}>
                {t.ranges.groups[g.group]}
              </option>
            ))}
          </select>
          <div className={styles.compareList}>
            {categories.map((row) => (
              <CompareRow key={row.id} label={filterLabel(row.id, t)} left={t.ranges.share(row.a)} right={t.ranges.share(row.b)} a={row.a} b={row.b} />
            ))}
          </div>
        </section>
      </div>

      <p className={`${analysis.muted} ${styles.rangeHover}`} aria-live="polite">
        {hovered ?? t.ranges.hoverEmpty}
      </p>

      <EquityChart data={data} views={views} masks={masks} />

      <p className={analysis.muted}>
        {t.ranges.note}
        {missingEv ? ` ${t.ranges.noEvNote(missingEv.position)}` : ""}
      </p>
    </div>
  );
}

function hoverLine(data: RangeData, views: Pair<SideView>, p: 0 | 1, k: number, t: SolverDict): string {
  const hands = data.byClass[p][k];
  const side = data.ranges.sides[p];
  let combos = 0;
  let ev = 0;
  let eq = 0;
  let eqWeight = 0;
  for (const i of hands) {
    const r = views[p].reach[i];
    if (r <= 0) continue;
    combos += r;
    if (side.ev) ev += r * side.ev[i];
    const e = data.equity?.[p][i];
    if (e !== undefined && !Number.isNaN(e)) {
      eq += r * e;
      eqWeight += r;
    }
  }
  return t.ranges.hover(
    GRID_CELLS[k].name,
    side.position,
    combos,
    eqWeight > 0 ? eq / eqWeight : null,
    side.ev && combos > 0 ? ev / combos : null,
  );
}

function CompareRow({ label, left, right, a, b, note }: { label: string; left: ReactNode; right: ReactNode; a: number; b: number; note?: string }) {
  const total = Math.max(0, a) + Math.max(0, b);
  const share = total > 0 ? Math.max(0, a) / total : 0.5;
  return (
    <div className={styles.compareRow}>
      <span className={`${analysis.num} ${a >= b ? styles.compareWin : ""}`}>{left}</span>
      <span className={styles.compareLabel}>{label}</span>
      <span className={`${analysis.num} ${b >= a ? styles.compareWin : ""}`}>{right}</span>
      <span className={styles.compareBar} aria-hidden="true">
        <span className={styles.compareA} style={{ inlineSize: `${share * 100}%` }} />
        <span className={styles.compareB} style={{ inlineSize: `${(1 - share) * 100}%` }} />
      </span>
      {note ? <span className={`${analysis.muted} ${styles.compareNote}`}>{note}</span> : null}
    </div>
  );
}

function RangeGrid({
  data,
  view,
  p,
  mode,
  strategy,
  onHover,
}: {
  data: RangeData;
  view: SideView;
  p: 0 | 1;
  mode: Mode;
  strategy: StrategyModel;
  onHover: (k: number | null) => void;
}) {
  const t = useSolverDict();
  const side = data.ranges.sides[p];
  const pot = data.ranges.pot;
  const eq = data.equity?.[p] ?? null;
  const value = (i: number): number | null => {
    switch (mode) {
      case "ev":
        return side.ev ? side.ev[i] / pot : null;
      case "equity":
        return eq && !Number.isNaN(eq[i]) ? eq[i] : null;
      case "eqr":
        return side.ev && eq && eq[i] > 0 ? side.ev[i] / (eq[i] * pot) / EQR_TOP : side.ev && eq ? 0 : null;
      default:
        return 1;
    }
  };
  const colour = p === 0 ? styles.sideA : styles.sideB;

  return (
    <div className={styles.rangeGrid} role="img" aria-label={t.ranges.gridLabel(side.position, t.ranges.modes[mode])} onPointerLeave={() => onHover(null)}>
      {GRID_CELLS.map((cell) => {
        const k = cell.index;
        const hands = data.byClass[p][k];
        let combos = 0;
        let sum = 0;
        let weight = 0;
        for (const i of hands) {
          const r = view.reach[i];
          if (r <= 0) continue;
          combos += r;
          if (mode === "ev" && side.ev) {
            sum += r * side.ev[i];
            weight += r;
          } else if ((mode === "equity" || mode === "eqr") && eq && !Number.isNaN(eq[i])) {
            sum += r * (mode === "eqr" && side.ev ? side.ev[i] : eq[i]);
            weight += r * (mode === "eqr" ? eq[i] * pot : 1);
          }
        }
        const mean = mode === "range" ? combos : weight > 0 ? sum / weight : null;
        const label = mean === null || combos === 0 || mode === "strategy" ? "" : t.ranges.cellValue[mode](mean);
        const model = strategy.classes[k];
        return (
          <div
            key={cell.name}
            className={`${styles.cell} ${styles.rangeCell} ${combos === 0 ? styles.cellFaint : ""}`}
            title={t.ranges.cellLabel(cell.name, combos, label || null)}
            onPointerEnter={() => onHover(k)}
          >
            {combos === 0 ? null : mode === "strategy" ? (
              model.state === "absent" ? null : (
                <span className={styles.cellFill} aria-hidden="true" style={{ blockSize: `${Math.max(8, model.fill * 100)}%` }}>
                  {model.freq.map((freq, a) =>
                    freq > 0 ? <span key={a} className={strategy.actions[a].colour} style={{ inlineSize: `${freq * 100}%` }} /> : null,
                  )}
                </span>
              )
            ) : (
              <span className={styles.comboFill} aria-hidden="true">
                {hands.map((i) => {
                  const v = value(i);
                  const r = view.reach[i];
                  return (
                    <span
                      key={i}
                      className={mode === "range" ? colour : undefined}
                      style={{ blockSize: `${r * 100}%`, background: mode === "range" || v === null ? undefined : heat(v) }}
                    />
                  );
                })}
              </span>
            )}
            <span className={styles.cellName}>{cell.name}</span>
            {label ? <span className={styles.cellEv}>{label}</span> : null}
          </div>
        );
      })}
    </div>
  );
}

/** Each range's combos by equity, weakest first, across the share of the range; the filter's combos drawn bold. */
function EquityChart({ data, views, masks }: { data: RangeData; views: Pair<SideView>; masks: Pair<Uint8Array> | null }) {
  const t = useSolverDict();
  const lines = useMemo(() => {
    if (!data.equity) return null;
    return ([0, 1] as const).map((p) => {
      const side = data.ranges.sides[p];
      const eq = data.equity![p];
      const hands = Array.from(side.hands.keys()).filter((i) => side.reach[i] > 0 && !Number.isNaN(eq[i]));
      hands.sort((x, y) => eq[x] - eq[y]);
      const total = hands.reduce((sum, i) => sum + side.reach[i], 0);
      let at = 0;
      const points = hands.map((i) => {
        const x0 = (at / total) * 100;
        at += side.reach[i];
        return { i, x0, x1: (at / total) * 100, y: 100 - eq[i] * 100 };
      });
      const path = points.map((pt, n) => `${n === 0 ? "M" : "L"}${pt.x0.toFixed(2)} ${pt.y.toFixed(2)}H${pt.x1.toFixed(2)}`).join("");
      const bold = masks
        ? points
            .filter((pt) => masks[p][pt.i])
            .map((pt) => `M${pt.x0.toFixed(2)} ${pt.y.toFixed(2)}H${pt.x1.toFixed(2)}`)
            .join("")
        : "";
      return { path, bold };
    });
  }, [data, masks]);

  const names = data.ranges.sides.map((side) => side.position);
  return (
    <figure className={styles.equityChart}>
      <figcaption className={styles.chartHead}>
        <strong>{t.ranges.chart}</strong>
        {names.map((name, p) => (
          <span key={name} className={styles.legend}>
            <span className={`${styles.legendSwatch} ${p === 0 ? styles.sideA : styles.sideB}`} aria-hidden="true" />
            {name} {views[p].equity === null ? "" : t.ranges.share(views[p].equity!)}
          </span>
        ))}
      </figcaption>
      {lines ? (
        <div className={styles.chartBox}>
          <span className={styles.chartY} aria-hidden="true">
            {[100, 75, 50, 25, 0].map((y) => (
              <span key={y}>{y}</span>
            ))}
          </span>
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className={styles.chartSvg} role="img" aria-label={t.ranges.chartLabel(names[0], names[1])}>
            {[25, 50, 75].map((y) => (
              <line key={`h${y}`} x1="0" x2="100" y1={y} y2={y} className={styles.chartGrid} vectorEffect="non-scaling-stroke" />
            ))}
            {[25, 50, 75].map((x) => (
              <line key={`v${x}`} y1="0" y2="100" x1={x} x2={x} className={styles.chartGrid} vectorEffect="non-scaling-stroke" />
            ))}
            {lines.map((line, p) => (
              <g key={p} className={p === 0 ? styles.lineA : styles.lineB}>
                <path d={line.path} fill="none" strokeWidth={masks ? 1 : 2} vectorEffect="non-scaling-stroke" opacity={masks ? 0.5 : 1} />
                {line.bold ? <path d={line.bold} fill="none" strokeWidth={5} vectorEffect="non-scaling-stroke" /> : null}
              </g>
            ))}
          </svg>
          <span className={styles.chartX} aria-hidden="true">
            {[0, 25, 50, 75, 100].map((x) => (
              <span key={x}>{x}</span>
            ))}
          </span>
        </div>
      ) : (
        <p className={analysis.muted}>{t.ranges.computing}</p>
      )}
    </figure>
  );
}
