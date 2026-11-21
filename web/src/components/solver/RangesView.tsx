/**
 * The Ranges tab of a decision ("Studio"): both players' ranges side by side,
 * the way a solver's viewer compares them.
 *
 * ```
 * BB [EV ▾]   0 ━━━━ 6.2  │ both ranges: combos, equity, EV, EQR, │ UTG to act [Strategy ▾]
 * out of position's grid  │ the equity curves, then made hands /  │ in position's grid
 *                         │ draws / equity buckets, each's share  │
 * ```
 *
 * Each grid has its own measure (`modes`, by role, so it stays put as the
 * line is walked): the player to act's opens on their strategy, the Strategy
 * tab's cell (the action colours, as tall as the class's reach); the other
 * measures - EV, equity, EQR - are a heat map, red low through yellow to
 * green high, with its scale beside the picker; Range is the weight alone.
 * A cell's fill is as tall as the share of the class in the range, as on the
 * Strategy tab. Everything counts only the combos that pass the hand filter
 * (`masks`); the curves draw them bold.
 *
 * Hovering a hand opens it in the panel on the right (`onHand`): the player to
 * act's as on the Strategy tab, each combo with its own mix; the other's as a
 * list of its combos with their weight, equity and EV.
 */

"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { RailLoader } from "@rail/ui/loader/RailLoader";
import { useSolverDict } from "./host";
import { classOfCombo, DRAWS, EQ_BANDS, EQ_BUCKETS, filterId, MADE_HANDS, comboIds, type FilterGroup } from "../../lib/solver";
import { GRID_CELLS } from "../analysis/chartSpots";
import analysis from "../analysis/analysis.module.css";
import { filterLabel } from "./HandFilters";
import type { RangeData } from "./rangeData";
import { ComboText, SHOWN_FREQ, type MainHand, type StrategyModel } from "./StrategyView";
import { SignedBb } from "./ui";
import styles from "./solver.module.css";

type Pair<T> = [T, T];
/** What a grid shows: the actor's strategy (theirs only), or a measure of each class. */
export type RangeMode = "strategy" | "ev" | "equity" | "range" | "eqr";
const RANGE_MODES: readonly RangeMode[] = ["strategy", "ev", "equity", "range", "eqr"];
/** Each grid's measure by role, not by seat: the player to act's and the other's. */
export interface RangeModes {
  actor: RangeMode;
  other: RangeMode;
}
export const DEFAULT_RANGE_MODES: RangeModes = { actor: "strategy", other: "ev" };
type Group = Exclude<FilterGroup, "suit">;
const GROUPS: Array<{ group: Group; values: readonly string[] }> = [
  { group: "made", values: MADE_HANDS },
  { group: "draw", values: DRAWS },
  { group: "eq", values: EQ_BUCKETS },
  { group: "band", values: EQ_BANDS },
];
/** EQR at the green end of the scale: 100% (the hand realises its equity) sits in the middle. */
const EQR_TOP = 2;
/** A class's fill is never shorter than this, so a thin one still shows its colour. */
const MIN_FILL = 0.1;

/** The heat map, 0..1: the loss red (low) through the EV yellow (the middle) to the profit green (high). */
function heat(t: number): string {
  const x = Math.max(0, Math.min(1, t));
  return x < 0.5
    ? `color-mix(in oklab, var(--ev-fg) ${Math.round(x * 200)}%, var(--loss-fg))`
    : `color-mix(in oklab, var(--profit-fg) ${Math.round((x - 0.5) * 200)}%, var(--ev-fg))`;
}

/** Where a class's mean sits on the heat map: equity as it is, EV as a share of the pot, EQR up to `EQR_TOP`. */
function heatLevel(mode: RangeMode, mean: number, pot: number): number {
  return mode === "ev" ? mean / pot : mode === "eqr" ? mean / EQR_TOP : mean;
}

interface SideView {
  reach: Float64Array;
  /** Per class (grid order): its combos that pass the filter, reached or not (a fill's 100%). */
  classCombos: Float64Array;
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
  const classCombos = new Float64Array(169);
  side.reach.forEach((r, i) => {
    full += r;
    if (!mask || mask[i]) classCombos[classOfCombo(side.hands[i])] += 1;
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
    classCombos,
    combos,
    full,
    ev: meanEv,
    equity: meanEq,
    eqr: meanEv !== null && meanEq ? meanEv / (meanEq * pot) : null,
    shares,
  };
}

export function RangesView({
  data,
  masks,
  strategy,
  modes,
  onModes,
  onHand,
}: {
  data: RangeData;
  masks: Pair<Uint8Array> | null;
  /** The player to act's decision, as the Strategy tab draws it (the hand filter applied): their grid's Strategy. */
  strategy: StrategyModel;
  /** What each grid shows, by role. */
  modes: RangeModes;
  onModes: (modes: RangeModes) => void;
  onHand?: (hand: MainHand | null) => void;
}) {
  const t = useSolverDict();
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
  const role = (p: 0 | 1): keyof RangeModes => (p === ranges.actor ? "actor" : "other");
  /** Strategy is the actor's alone; EV (and EQR) is not stored for a side right after a dealt card: its grid shows equity. */
  const choices = (p: 0 | 1): RangeMode[] =>
    RANGE_MODES.filter((m) => (m !== "strategy" || p === ranges.actor) && ((m !== "ev" && m !== "eqr") || ranges.sides[p].ev));
  const modeOf = (p: 0 | 1): RangeMode => {
    const mode = modes[role(p)];
    return choices(p).includes(mode) ? mode : mode === "strategy" ? "ev" : "equity";
  };

  // Equity is worked out a moment after the click: the inline loader until then.
  const equityLoading = <RailLoader size="inline" label={t.ranges.equityLoading} />;
  const stats: Array<{ label: string; left: ReactNode; right: ReactNode; a: number; b: number; title?: string }> = [
    {
      label: t.ranges.combos,
      left: t.ranges.cellValue.range(views[0].combos),
      right: t.ranges.cellValue.range(views[1].combos),
      a: views[0].combos,
      b: views[1].combos,
      title: masks ? `${t.ranges.share(views[0].full > 0 ? views[0].combos / views[0].full : 0)} · ${t.ranges.share(views[1].full > 0 ? views[1].combos / views[1].full : 0)}` : undefined,
    },
    {
      label: t.ranges.equity,
      left: views[0].equity === null ? equityLoading : t.ranges.share(views[0].equity),
      right: views[1].equity === null ? equityLoading : t.ranges.share(views[1].equity),
      a: views[0].equity ?? 0,
      b: views[1].equity ?? 0,
    },
    {
      label: t.ranges.ev,
      left: views[0].ev === null ? t.ranges.noEv : t.ranges.bb(views[0].ev),
      right: views[1].ev === null ? t.ranges.noEv : t.ranges.bb(views[1].ev),
      a: views[0].ev ?? 0,
      b: views[1].ev ?? 0,
      title:
        views[0].ev !== null && views[1].ev !== null
          ? `${t.ranges.share(views[0].ev / ranges.pot)} · ${t.ranges.share(views[1].ev / ranges.pot)}`
          : undefined,
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

  // The hovered hand in the panel; re-sent as the equity comes in or the filter changes, cleared on leaving the tab.
  useEffect(() => {
    if (!onHand) return;
    if (!hover) onHand(null);
    else if (hover.p === ranges.actor) onHand({ index: hover.k });
    else onHand({ panel: <OtherHand data={data} view={views[hover.p]} p={hover.p} k={hover.k} /> });
  }, [onHand, hover, data, views, ranges.actor]);
  useEffect(() => () => onHand?.(null), [onHand]);

  const missingEv = ranges.sides.find((side) => !side.ev);
  const names = ranges.sides.map((side) => side.position);

  return (
    <div className={styles.ranges}>
      {([0, 1] as const).map((p) => (
        <div key={p} className={styles.rangeSide} style={{ order: p === 0 ? 0 : 2 }}>
          <span className={styles.rangeHead}>
            <strong>{ranges.sides[p].position}</strong>
            {p === ranges.actor ? <span className={styles.toAct}>{t.preflop.toAct}</span> : null}
            <select
              className={styles.modeSelect}
              aria-label={t.ranges.mode(ranges.sides[p].position)}
              value={modeOf(p)}
              onChange={(event) => onModes({ ...modes, [role(p)]: event.target.value as RangeMode })}
            >
              {choices(p).map((m) => (
                <option key={m} value={m}>
                  {t.ranges.modes[m]}
                </option>
              ))}
            </select>
            <HeatScale mode={modeOf(p)} pot={ranges.pot} />
          </span>
          <RangeGrid
            data={data}
            view={views[p]}
            p={p}
            mode={modeOf(p)}
            strategy={strategy}
            hovered={hover?.p === p ? hover.k : null}
            onHover={(k) => setHover(k === null ? null : { p, k })}
          />
        </div>
      ))}

      <section
        className={styles.stats}
        aria-label={t.ranges.compare}
        title={`${t.ranges.note}${missingEv ? ` ${t.ranges.noEvNote(missingEv.position)}` : ""}`}
      >
        <div className={styles.statTable}>
          <span />
          <span className={styles.statHead}>{names[0]}</span>
          <span className={styles.statHead}>{names[1]}</span>
          {stats.map((row) => (
            <StatRow key={row.label} {...row} />
          ))}
        </div>
        <EquityCurves data={data} masks={masks} />
        <div className={styles.statGroup}>
          <select className={styles.modeSelect} aria-label={t.ranges.groupPick} value={shownGroup} onChange={(event) => setGroup(event.target.value as Group)}>
            {groups.map((g) => (
              <option key={g.group} value={g.group}>
                {t.ranges.groups[g.group]}
              </option>
            ))}
          </select>
          <div className={`${styles.statTable} ${styles.statList}`}>
            {categories.map((row) => (
              <StatRow key={row.id} label={filterLabel(row.id, t)} left={t.ranges.share(row.a)} right={t.ranges.share(row.b)} a={row.a} b={row.b} />
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

function StatRow({ label, left, right, a, b, title }: { label: string; left: ReactNode; right: ReactNode; a: number; b: number; title?: string }) {
  return (
    <>
      <span className={styles.statLabel} title={title}>
        {label}
      </span>
      <span className={`${analysis.num} ${a > b ? styles.statWin : ""}`}>{left}</span>
      <span className={`${analysis.num} ${b > a ? styles.statWin : ""}`}>{right}</span>
    </>
  );
}

/** The other player's hovered hand, for the panel: each combo's weight, equity and EV (they do not act here). */
function OtherHand({ data, view, p, k }: { data: RangeData; view: SideView; p: 0 | 1; k: number }) {
  const t = useSolverDict();
  const side = data.ranges.sides[p];
  const eq = data.equity?.[p] ?? null;
  const hands = data.byClass[p][k];
  let combos = 0;
  let ev = 0;
  for (const i of hands) {
    const r = view.reach[i];
    combos += r;
    if (side.ev) ev += r * side.ev[i];
  }
  return (
    <>
      <p className={styles.handHead}>
        <strong className={styles.handName}>{GRID_CELLS[k].name}</strong>
        <span className={styles.positionTag}>{side.position}</span>
        {side.ev && combos > 0 ? <SignedBb className={styles.handValue} value={ev / combos} text={t.signedBb(ev / combos)} /> : null}
      </p>
      {hands.length === 0 ? (
        <p className={analysis.muted}>{t.absent}</p>
      ) : (
        <table className={styles.otherCombos}>
          <thead>
            <tr>
              <th />
              <th>{t.ranges.modes.range}</th>
              <th>{t.ranges.equity}</th>
              <th>{t.ranges.ev}</th>
            </tr>
          </thead>
          <tbody>
            {hands.map((i) => {
              const e = eq ? eq[i] : Number.NaN;
              return (
                <tr key={i} className={view.reach[i] > 0 ? undefined : styles.otherComboOff}>
                  <th scope="row">
                    <ComboText cards={data.cards[p][i]} />
                  </th>
                  <td>{t.ranges.share(view.reach[i])}</td>
                  <td>{Number.isNaN(e) ? t.ranges.noEv : t.ranges.share(e)}</td>
                  <td>{side.ev ? t.ranges.bb(side.ev[i]) : t.ranges.noEv}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className={analysis.muted}>{t.ranges.otherNote(side.position)}</p>
    </>
  );
}

/** The heat map's scale beside a grid's picker: its two ends, red to green (none for Strategy and Range). */
function HeatScale({ mode, pot }: { mode: RangeMode; pot: number }) {
  const t = useSolverDict();
  if (mode !== "ev" && mode !== "equity" && mode !== "eqr") return null;
  const [low, high] = t.ranges.scale[mode](pot);
  return (
    <span className={styles.heatScale} role="img" aria-label={t.ranges.scaleLabel(t.ranges.modes[mode], low, high)}>
      <span>{low}</span>
      <span className={styles.heatScaleBar} aria-hidden="true" />
      <span>{high}</span>
    </span>
  );
}

function RangeGrid({
  data,
  view,
  p,
  mode,
  strategy,
  hovered,
  onHover,
}: {
  data: RangeData;
  view: SideView;
  p: 0 | 1;
  mode: RangeMode;
  strategy: StrategyModel;
  hovered: number | null;
  onHover: (k: number | null) => void;
}) {
  const t = useSolverDict();
  const side = data.ranges.sides[p];
  const pot = data.ranges.pot;
  const eq = data.equity?.[p] ?? null;

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
        const out = combos === 0;
        // As tall as the share of the class in the range (the filter's combos), as on the Strategy tab.
        const height = `${Math.max(MIN_FILL, view.classCombos[k] > 0 ? Math.min(1, combos / view.classCombos[k]) : 0) * 100}%`;
        let fill: ReactNode = null;
        let label = "";
        if (mode === "strategy") {
          // The Strategy tab's cell: the class's mix as action-coloured columns.
          const model = strategy.classes[k];
          label = model.freq
            .map((freq, a) => (freq >= SHOWN_FREQ ? t.part(strategy.actions[a].label, freq) : null))
            .filter(Boolean)
            .join(", ");
          fill =
            out || model.state === "absent" ? null : (
              <span className={styles.cellFill} aria-hidden="true" style={{ blockSize: height }}>
                {model.freq.map((freq, a) =>
                  freq > 0 ? <span key={a} className={strategy.actions[a].colour} style={{ inlineSize: `${freq * 100}%` }} /> : null,
                )}
              </span>
            );
        } else {
          const mean = mode === "range" ? combos : weight > 0 ? sum / weight : null;
          label = mean === null || out ? "" : t.ranges.cellValue[mode](mean);
          const background = mode === "range" ? "var(--accent-bg)" : mean === null ? null : heat(heatLevel(mode, mean, pot));
          fill = out || background === null ? null : <span className={styles.cellFill} aria-hidden="true" style={{ blockSize: height, background }} />;
        }
        return (
          <div
            key={cell.name}
            className={`${styles.heat} ${out ? styles.heatOut : ""} ${k === hovered ? styles.heatHover : ""}`}
            title={t.ranges.cellLabel(cell.name, combos, label || null)}
            onPointerEnter={() => onHover(k)}
          >
            {fill}
            <span className={styles.heatName}>{cell.name}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Each range's combos by equity, weakest first, across the share of the range; the filter's combos drawn bold. */
function EquityCurves({ data, masks }: { data: RangeData; masks: Pair<Uint8Array> | null }) {
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
    <figure className={styles.curves}>
      {lines ? (
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className={styles.curveSvg} role="img" aria-label={t.ranges.chartLabel(names[0], names[1])}>
          <line x1="0" x2="100" y1="50" y2="50" className={styles.curveMid} vectorEffect="non-scaling-stroke" />
          {lines.map((line, p) => (
            <g key={p} className={p === 0 ? styles.lineA : styles.lineB}>
              <path d={line.path} fill="none" strokeWidth={masks ? 1 : 2} vectorEffect="non-scaling-stroke" opacity={masks ? 0.5 : 1} />
              {line.bold ? <path d={line.bold} fill="none" strokeWidth={4} vectorEffect="non-scaling-stroke" /> : null}
            </g>
          ))}
        </svg>
      ) : (
        <p className={analysis.muted}>{t.ranges.computing}</p>
      )}
      <figcaption className={styles.curveLegend}>
        {names.map((name, p) => (
          <span key={name} className={styles.legend}>
            <span className={`${styles.legendSwatch} ${p === 0 ? styles.sideA : styles.sideB}`} aria-hidden="true" />
            {name}
          </span>
        ))}
        <span className={styles.legendNote}>{t.ranges.equity}</span>
      </figcaption>
    </figure>
  );
}
