/**
 * The chart set editor (R5.3): the game a set is for, a situation picker,
 * the brush and the grid, and the tools - undo, clear, copy from another
 * situation, start from Rail's chart, paste ranges, copy as text.
 *
 * The set is the screen's (`ChartsScreen`), changed through `onChange`;
 * undo covers what is painted, cleared, copied and pasted (one step per
 * stroke), not the game's fields.
 */
import { useMemo, useRef, useState } from "react";

import { useUiStrings } from "../i18n";
import { ChartGrid, RankPicker } from "./ChartGrid";
import { importNodeText, type ImportProblem } from "./exchange";
import {
  CHART_ACTIONS,
  TABLE_POSITIONS,
  TABLE_SIZES,
  actionsOf,
  cloneNode,
  comboShare,
  emptyNode,
  formatNodeKey,
  isPlausible,
  nodeKeysFor,
  parseNodeKey,
  restActionOf,
  SCENARIOS,
  type ChartActionName,
  type ChartNode,
  type ChartSet,
  type NodeKey,
  type Position,
  type Scenario,
  type TableSize,
} from "./model";
import { formatBrackets, formatCombos, formatRange } from "./ranges";
import type { PreflopChartsSource } from "./source";
import styles from "./Charts.module.css";

type Brush = Record<ChartActionName, number>;

const PRESETS: ReadonlyArray<Brush> = [
  { raise: 100, call: 0, allin: 0 },
  { raise: 0, call: 100, allin: 0 },
  { raise: 0, call: 0, allin: 100 },
  { raise: 50, call: 50, allin: 0 },
  { raise: 50, call: 0, allin: 0 },
  { raise: 0, call: 0, allin: 0 },
];

/** The node with the actions the key does not allow moved to the rest. */
export function adaptNode(node: ChartNode, key: NodeKey): ChartNode {
  const out = cloneNode(node);
  const allowed = actionsOf(key);
  for (const action of CHART_ACTIONS) if (!allowed.includes(action)) out.freq[action].fill(0);
  return out;
}

/** The keys of a set that its table cannot have (dropped on save). */
export function strayKeys(set: ChartSet): string[] {
  return [...set.nodes.keys()].filter((key) => {
    const parsed = parseNodeKey(key);
    return !parsed || !isPlausible(parsed, set.tableSize);
  });
}

export interface ChartEditorProps {
  set: ChartSet;
  onChange: (set: ChartSet) => void;
  source: PreflopChartsSource;
  /** The situation to open at (the comparison's "Fill it in"). */
  initialKey?: string | null;
}

export function ChartEditor({ set, onChange, source, initialKey = null }: ChartEditorProps) {
  const ui = useUiStrings();
  const t = ui.charts;
  const keys = useMemo(() => nodeKeysFor(set.tableSize), [set.tableSize]);
  const [current, setCurrent] = useState<NodeKey>(() => {
    const wanted = initialKey ? parseNodeKey(initialKey, set.tableSize) : null;
    const filled = [...set.nodes.keys()].map((k) => parseNodeKey(k, set.tableSize)).find(Boolean);
    return wanted ?? filled ?? keys[0];
  });
  const key = isPlausible(current, set.tableSize) ? current : keys[0];
  const keyText = formatNodeKey(key);
  const node = set.nodes.get(keyText) ?? null;
  const rest = restActionOf(key);
  const allowed = actionsOf(key);
  const [brush, setBrush] = useState<Brush>({ raise: 100, call: 0, allin: 0 });
  const [undo, setUndo] = useState<Array<{ key: string; node: ChartNode | null }>>([]);
  const [note, setNote] = useState<string | null>(null);
  const [copyFrom, setCopyFrom] = useState("");
  const shipped = source.shippedSets().filter((s) => s.tableSize === set.tableSize);
  const [railSet, setRailSet] = useState(() => {
    const mid = (set.stackMinBb + set.stackMaxBb) / 2;
    return [...shipped].sort((a, b) => Math.abs(a.depthBb - mid) - Math.abs(b.depthBb - mid))[0]?.id ?? "";
  });
  const [texts, setTexts] = useState<Partial<Record<ChartActionName, string>>>({});
  const [pasteProblems, setPasteProblems] = useState<ImportProblem[]>([]);
  const [exportFormat, setExportFormat] = useState<"range" | "brackets" | "combos">("range");
  const brushOver = brush.raise + brush.call + brush.allin > 100;
  const label = (k: NodeKey) => t.situation.label(k.scenario, k.hero, k.vs);

  const setNode = (k: string, next: ChartNode | null) => {
    const nodes = new Map(set.nodes);
    if (next) nodes.set(k, next);
    else nodes.delete(k);
    onChange({ ...set, nodes });
  };
  const remember = () => setUndo((stack) => [...stack.slice(-49), { key: keyText, node: node ? cloneNode(node) : null }]);
  const replace = (next: ChartNode | null) => {
    remember();
    setNode(keyText, next);
  };

  // A stroke paints onto its own copy, so cells painted before the screen
  // re-renders are not lost to a stale node.
  const stroke = useRef<{ key: string; node: ChartNode } | null>(null);
  const strokeStart = () => {
    remember();
    stroke.current = { key: keyText, node: node ? cloneNode(node) : emptyNode() };
  };
  const paint = (classes: number[]) => {
    if (brushOver) return;
    const next =
      stroke.current && stroke.current.key === keyText ? stroke.current.node : node ? cloneNode(node) : emptyNode();
    for (const cls of classes) {
      for (const action of CHART_ACTIONS) next.freq[action][cls] = allowed.includes(action) ? brush[action] : 0;
    }
    stroke.current = { key: keyText, node: next };
    setNode(keyText, cloneNode(next));
  };

  const pick = (next: Partial<NodeKey>) => {
    const scenario = (next.scenario ?? key.scenario) as Scenario;
    const hero = (next.hero ?? key.hero) as Position;
    let vs = scenario === "rfi" ? null : ((next.vs !== undefined ? next.vs : key.vs) as Position | null);
    let candidate: NodeKey = { scenario, hero, vs };
    if (!isPlausible(candidate, set.tableSize)) {
      // Keep what was changed; take the first plausible rest.
      const match =
        keys.find((k) => k.scenario === scenario && k.hero === hero) ?? keys.find((k) => k.scenario === scenario) ?? keys[0];
      vs = match.vs;
      candidate = match.hero === hero ? { scenario, hero, vs } : match;
    }
    setCurrent(candidate);
    setNote(null);
    setPasteProblems([]);
    setTexts({});
  };

  const heroes = TABLE_POSITIONS[set.tableSize].filter((p) => keys.some((k) => k.scenario === key.scenario && k.hero === p));
  const villains = keys.filter((k) => k.scenario === key.scenario && k.hero === key.hero).map((k) => k.vs as Position);
  const filled = [...set.nodes.keys()].map((k) => parseNodeKey(k, set.tableSize)).filter((k): k is NodeKey => k !== null);
  const percentText = (value: number) => (value * 100).toLocaleString(ui.intlLocale, { maximumFractionDigits: 1 });
  const stray = strayKeys(set);

  const format = exportFormat === "range" ? formatRange : exportFormat === "brackets" ? formatBrackets : formatCombos;
  const problemText = (p: ImportProblem) =>
    p.code === "range" ? t.problems.range(p.where, p.detail)
    : p.code === "over-100" ? t.problems["over-100"](`${p.where} ${p.detail}`)
    : t.problems["action-not-allowed"](p.where);

  return (
    <div className={styles.editor}>
      <section className={styles.card} aria-labelledby="charts-game">
        <h2 id="charts-game" className={styles.cardTitle}>
          {t.game.heading}
        </h2>
        <div className={styles.fields}>
          <label className={`${styles.field} ${styles.fieldWide}`}>
            <span className={styles.fieldLabel}>{t.game.name}</span>
            <input value={set.name} maxLength={80} onChange={(event) => onChange({ ...set, name: event.target.value })} />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t.game.format}</span>
            <select
              value={set.gameFormat}
              onChange={(event) => onChange({ ...set, gameFormat: event.target.value === "tournament" ? "tournament" : "cash" })}
            >
              <option value="cash">{t.game.formats.cash}</option>
              <option value="tournament">{t.game.formats.tournament}</option>
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t.game.table}</span>
            <select
              value={set.tableSize}
              onChange={(event) => onChange({ ...set, tableSize: Number(event.target.value) as TableSize })}
            >
              {TABLE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {t.game.tables[size]}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t.game.stackFrom}</span>
            <input
              type="number"
              inputMode="decimal"
              min={1}
              max={1000}
              value={set.stackMinBb}
              onChange={(event) => onChange({ ...set, stackMinBb: Number(event.target.value) })}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t.game.stackTo}</span>
            <input
              type="number"
              inputMode="decimal"
              min={1}
              max={1000}
              value={set.stackMaxBb}
              onChange={(event) => onChange({ ...set, stackMaxBb: Number(event.target.value) })}
            />
          </label>
        </div>
        {stray.length > 0 ? <p className={styles.warning}>{t.game.tableChange(stray.length)}</p> : null}
      </section>

      <section className={styles.card} aria-labelledby="charts-situation">
        <h2 id="charts-situation" className={styles.cardTitle}>
          {t.situation.heading}
        </h2>
        <div className={styles.fields}>
          <label className={`${styles.field} ${styles.fieldWide}`}>
            <span className={styles.fieldLabel}>{t.situation.scenario}</span>
            <select value={key.scenario} onChange={(event) => pick({ scenario: event.target.value as Scenario })}>
              {SCENARIOS.filter((s) => keys.some((k) => k.scenario === s)).map((s) => (
                <option key={s} value={s}>
                  {t.situation.scenarios[s]}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t.situation.hero}</span>
            <select value={key.hero} onChange={(event) => pick({ hero: event.target.value as Position })}>
              {heroes.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          {key.vs !== null ? (
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{t.situation.villain}</span>
              <select value={key.vs} onChange={(event) => pick({ vs: event.target.value as Position })}>
                {villains.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        {filled.length > 0 ? (
          <div className={`${styles.chips} ${styles.filled}`} role="group" aria-label={t.situation.filled}>
            <span className={styles.fieldLabel}>{t.situation.filled}</span>
            {filled.map((k) => (
              <button
                key={formatNodeKey(k)}
                type="button"
                className={`btn btn--sm${formatNodeKey(k) === keyText ? " btn--primary" : ""}`}
                aria-pressed={formatNodeKey(k) === keyText}
                onClick={() => pick(k)}
              >
                {label(k)}
              </button>
            ))}
          </div>
        ) : (
          <p className={`${styles.muted} ${styles.filled}`}>{t.situation.none}</p>
        )}
      </section>

      <section className={styles.card} aria-labelledby="charts-paint">
        <h2 id="charts-paint" className={styles.cardTitle}>
          {label(key)}
        </h2>
        <div className={styles.brush} role="group" aria-label={t.brush.heading}>
          <p className={styles.muted}>{t.brush.help}</p>
          <div className={styles.fields}>
            {allowed.map((action) => (
              <label key={action} className={styles.field}>
                <span className={styles.fieldLabel}>
                  {t.brush.percent(action === "call" && (key.scenario === "rfi" || key.scenario === "vs-limp") ? t.limp : t.actions[action])}
                </span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={100}
                  step={5}
                  value={brush[action]}
                  onChange={(event) =>
                    setBrush({ ...brush, [action]: Math.max(0, Math.min(100, Math.round(Number(event.target.value) || 0))) })
                  }
                />
              </label>
            ))}
            <p className={styles.restLine} aria-live="polite">
              {brushOver ? t.brush.over : t.brush.rest(t.actions[rest], 100 - brush.raise - brush.call - brush.allin)}
            </p>
          </div>
          <div className={styles.chips} role="group" aria-label={t.brush.presets}>
            {PRESETS.filter((p) => allowed.includes("call") || p.call === 0).map((preset, i) => {
              const parts = CHART_ACTIONS.filter((a) => preset[a] > 0).map((a) => t.brush.rest(t.actions[a], preset[a]));
              const left = 100 - preset.raise - preset.call - preset.allin;
              if (left > 0) parts.push(t.brush.rest(t.actions[rest], left));
              const active = CHART_ACTIONS.every((a) => preset[a] === brush[a]);
              return (
                <button
                  key={i}
                  type="button"
                  className={`btn btn--sm${active ? " btn--primary" : ""}`}
                  aria-pressed={active}
                  onClick={() => setBrush({ ...preset })}
                >
                  {parts.join(" / ")}
                </button>
              );
            })}
          </div>
        </div>

        <ChartGrid
          node={node}
          rest={rest}
          label={t.grid.label(label(key))}
          onPaint={paint}
          onStrokeStart={strokeStart}
        />
        <p className={styles.shares}>
          {[...allowed, rest].map((action) => (
            <span key={action} className={styles.share}>
              <span className={`${styles.dot} ${styles[`dot_${action}`] ?? ""}`} aria-hidden="true" />
              {t.grid.share(t.actions[action], percentText(node ? comboShare(node, action) : action === rest ? 1 : 0))}
            </span>
          ))}
        </p>
        <RankPicker
          node={node}
          rest={rest}
          onPaint={(classes) => {
            strokeStart();
            paint(classes);
          }}
        />

        <div className={styles.toolbar}>
          <button
            type="button"
            className="btn btn--sm"
            disabled={undo.length === 0}
            onClick={() => {
              const last = undo[undo.length - 1];
              if (!last) return;
              setUndo(undo.slice(0, -1));
              setNode(last.key, last.node);
              const parsed = parseNodeKey(last.key, set.tableSize);
              if (parsed) setCurrent(parsed);
            }}
          >
            {t.tools.undo}
          </button>
          <button type="button" className="btn btn--sm" disabled={!node} onClick={() => replace(null)}>
            {t.tools.clear}
          </button>
        </div>
        {note ? (
          <p className={styles.muted} role="status">
            {note}
          </p>
        ) : null}

        <details className={styles.tool}>
          <summary>{t.tools.copyFrom}</summary>
          <div className={styles.fields}>
            <label className={`${styles.field} ${styles.fieldWide}`}>
              <span className={styles.fieldLabel}>{t.situation.heading}</span>
              <select value={copyFrom} onChange={(event) => setCopyFrom(event.target.value)}>
                <option value="" />
                {filled
                  .filter((k) => formatNodeKey(k) !== keyText)
                  .map((k) => (
                    <option key={formatNodeKey(k)} value={formatNodeKey(k)}>
                      {label(k)}
                    </option>
                  ))}
              </select>
            </label>
            <button
              type="button"
              className="btn btn--sm"
              disabled={!set.nodes.get(copyFrom)}
              onClick={() => {
                const from = set.nodes.get(copyFrom);
                if (!from) return;
                replace(adaptNode(from, key));
                setNote(t.tools.copied);
              }}
            >
              {t.tools.copy}
            </button>
          </div>
        </details>

        {shipped.length > 0 ? (
          <details className={styles.tool}>
            <summary>{t.tools.copyRail}</summary>
            <p className={styles.muted}>{t.tools.copyRailHelp}</p>
            <div className={styles.fields}>
              <label className={`${styles.field} ${styles.fieldWide}`}>
                <span className={styles.fieldLabel}>{t.tools.railSetLabel}</span>
                <select value={railSet} onChange={(event) => setRailSet(event.target.value)}>
                  {shipped.map((s) => (
                    <option key={s.id} value={s.id}>
                      {t.tools.railSet(t.game.tablesShort[s.tableSize], s.depthBb)}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="btn btn--sm"
                disabled={!railSet}
                onClick={async () => {
                  const from = await source.shippedNode(railSet, keyText).catch(() => null);
                  if (!from) {
                    setNote(t.tools.railMissing);
                    return;
                  }
                  replace(adaptNode(from, key));
                  setNote(t.tools.copied);
                }}
              >
                {t.tools.copy}
              </button>
            </div>
          </details>
        ) : null}

        <details className={styles.tool}>
          <summary>{t.tools.importText}</summary>
          <p className={styles.muted}>{t.tools.importHelp}</p>
          {allowed.map((action) => (
            <label key={action} className={`${styles.field} ${styles.fieldFull}`}>
              <span className={styles.fieldLabel}>{t.actions[action]}</span>
              <textarea
                rows={2}
                spellCheck={false}
                value={texts[action] ?? ""}
                onChange={(event) => setTexts({ ...texts, [action]: event.target.value })}
              />
            </label>
          ))}
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t.tools.raiseSize}</span>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step={0.5}
              value={node?.raiseBb ?? ""}
              onChange={(event) => {
                const value = event.target.value === "" ? null : Number(event.target.value);
                const next = node ? cloneNode(node) : emptyNode();
                next.raiseBb = value !== null && Number.isFinite(value) && value > 0 ? value : null;
                setNode(keyText, next);
              }}
            />
          </label>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              const result = importNodeText(key, texts, node?.raiseBb ?? null);
              if (!result.ok) {
                setPasteProblems(result.problems);
                return;
              }
              setPasteProblems([]);
              replace(result.value);
              setNote(t.tools.copied);
            }}
          >
            {t.tools.apply}
          </button>
          {pasteProblems.length > 0 ? (
            <ul className={styles.problems} role="alert">
              {pasteProblems.map((p, i) => (
                <li key={i}>{problemText(p)}</li>
              ))}
            </ul>
          ) : null}
        </details>

        <details className={styles.tool}>
          <summary>{t.tools.exportText}</summary>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t.tools.exportFormat}</span>
            <select value={exportFormat} onChange={(event) => setExportFormat(event.target.value as typeof exportFormat)}>
              {(["range", "brackets", "combos"] as const).map((f) => (
                <option key={f} value={f}>
                  {t.tools.exportFormats[f]}
                </option>
              ))}
            </select>
          </label>
          {allowed.map((action) => (
            <label key={action} className={`${styles.field} ${styles.fieldFull}`}>
              <span className={styles.fieldLabel}>{t.actions[action]}</span>
              <textarea rows={2} readOnly spellCheck={false} value={node ? format(node.freq[action]) : ""} />
            </label>
          ))}
        </details>
      </section>
    </div>
  );
}
