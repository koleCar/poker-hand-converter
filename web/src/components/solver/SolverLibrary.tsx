/**
 * The Solver library (`/solver`): the flop library's solves, browsed one
 * decision at a time, the way a solver's viewer shows a spot.
 *
 * ```
 * a table (a chart set the library holds) ─▶ its manifest: the solved lines and flops
 *   ─▶ a line and a flop ─▶ the chunk (`FlopLibraryLoader.load`, the analysis' own reader)
 *   ─▶ a decision (`exploreNode`): the actions, the 13×13 mix and EV, a hand's combos (`classCombos`)
 *   ─▶ an action ─▶ the next decision, until the flop's betting is over
 * ```
 *
 * Public, like the preflop chart browser: nothing here reads an account. The
 * chunks are the public bucket's, the same files the analysis grades with. The table, line, flop and decision live in the
 * address bar (`?set=…&line=…&flop=…&node=…`), so a link lands on the same
 * view. Cards are shown in the solve's canonical suits.
 */

"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CardRow } from "@rail/ui/cards/PlayingCard";
import {
  flopLibraryBase,
  flopLinesFor,
  flopPlayersOf,
  FlopLibraryLoader,
  lineSeats,
} from "../../lib/analysis/flopLibrary";
import { isRedSuit, SUIT_SYMBOL, type Suit } from "../../lib/cards";
import { CHART_SETS } from "../../lib/charts";
import { useDict } from "../../lib/i18n/client";
import { paths } from "../../lib/routes";
import {
  classCombos,
  exploreHistory,
  exploreNode,
  flopCards,
  flopFeatures,
  type ExploreAction,
  type ExploreNode,
  type FlopChunk,
} from "../../lib/solver";
import { SUPABASE_URL } from "../../lib/supabase/config";
import { GRID_CELLS } from "../analysis/chartSpots";
import analysis from "../analysis/analysis.module.css";
import styles from "./solver.module.css";

/** The chart sets the flop library is solved for, in the order offered. A set without a manifest yet says so. */
export const SOLVER_SETS = [
  "nlhe-cash-6max-100bb",
  "nlhe-cash-6max-150bb",
  "nlhe-cash-9max-100bb",
  "nlhe-cash-hu-100bb",
  "nlhe-cash-hu-150bb",
] as const;

/** Below this an action reads as 0.0%: left out of a cell's spoken mix. */
const SHOWN_FREQ = 0.0005;

type Texture = "rainbow" | "twoTone" | "monotone" | "paired" | "trips";
const TEXTURES: readonly Texture[] = ["rainbow", "twoTone", "monotone", "paired", "trips"];

function textureOf(flop: string): Texture {
  const cls = flopFeatures(flopCards(flop)).cls;
  if (cls === "t-r") return "trips";
  if (cls.startsWith("p-")) return "paired";
  if (cls === "u-m") return "monotone";
  return cls === "u-r" ? "rainbow" : "twoTone";
}

/** High card first, then the next: how a player scans a list of flops. */
function byRanks(a: string, b: string): number {
  const ra = flopFeatures(flopCards(a)).ranks;
  const rb = flopFeatures(flopCards(b)).ranks;
  return rb[0] - ra[0] || rb[1] - ra[1] || rb[2] - ra[2] || a.localeCompare(b);
}

let loader: FlopLibraryLoader | null | undefined;
function libraryLoader(): FlopLibraryLoader | null {
  if (loader === undefined) {
    const base = flopLibraryBase(SUPABASE_URL);
    loader = base ? new FlopLibraryLoader(base, (url) => fetch(url)) : null;
  }
  return loader;
}

/** The colour of an action: bets and raises darken with size, so two sizes never look alike. */
function actionClasses(actions: readonly ExploreAction[]): string[] {
  const aggressive = actions
    .map((action, a) => ({ action, a }))
    .filter(({ action }) => action.kind === "bet" || action.kind === "raise")
    .sort((x, y) => x.action.amount - y.action.amount);
  const shade = new Map(aggressive.map(({ a }, rank) => [a, aggressive.length - 1 - rank]));
  return actions.map((action, a) => {
    switch (action.kind) {
      case "fold":
        return analysis.actFold;
      case "check":
        return analysis.actCheck;
      case "call":
        return analysis.actCall;
      case "allin":
        return analysis.actAllin;
      default:
        return `${analysis.actRaise} ${styles[`lighter${Math.min(2, shade.get(a) ?? 0)}`] ?? ""}`;
    }
  });
}

type Entries = { set: string; status: "loading" } | { set: string; status: "ready"; byLine: Map<string, string[]> };
type Loaded =
  | { key: string; status: "loading" }
  | { key: string; status: "ready"; chunk: FlopChunk }
  | { key: string; status: "error" };

interface SolverLibraryProps {
  initialSet: string | null;
  initialLine: string | null;
  initialFlop: string | null;
  initialNode: number | null;
}

export function SolverLibrary(props: SolverLibraryProps) {
  const t = useDict().solver;
  if (!libraryLoader()) return <p className={analysis.muted}>{t.unavailable}</p>;
  return <Browser {...props} />;
}

function Browser({ initialSet, initialLine, initialFlop, initialNode }: SolverLibraryProps) {
  const t = useDict().solver;
  const router = useRouter();
  const [setId, setSetId] = useState<string>(
    initialSet && (SOLVER_SETS as readonly string[]).includes(initialSet) ? initialSet : SOLVER_SETS[0],
  );
  const [line, setLine] = useState<string | null>(initialLine);
  const [flop, setFlop] = useState<string | null>(initialFlop);
  const [node, setNode] = useState(initialNode ?? 0);
  const [texture, setTexture] = useState<Texture | null>(null);
  const [entries, setEntries] = useState<Entries>({ set: "", status: "loading" });
  const [loaded, setLoaded] = useState<Loaded>({ key: "", status: "loading" });
  const [attempt, setAttempt] = useState(0);

  const spec = CHART_SETS.find((s) => s.id === setId)!;
  const lines = flopLinesFor(spec.players);

  // The set's manifest: which lines and flops are solved.
  useEffect(() => {
    let live = true;
    void libraryLoader()!
      .listed(setId)
      .then((listed) => {
        if (!live) return;
        const byLine = new Map<string, string[]>();
        for (const { line: id, flop: key } of listed) byLine.set(id, [...(byLine.get(id) ?? []), key]);
        for (const flops of byLine.values()) flops.sort(byRanks);
        setEntries({ set: setId, status: "ready", byLine });
      });
    return () => {
      live = false;
    };
  }, [setId]);

  const byLine = entries.set === setId && entries.status === "ready" ? entries.byLine : null;
  const solvedLines = byLine ? lines.filter((l) => (byLine.get(l.id)?.length ?? 0) > 0) : [];
  const lineId = byLine ? (solvedLines.find((l) => l.id === line) ?? solvedLines[0])?.id ?? null : null;
  const flops = (lineId && byLine?.get(lineId)) || [];
  const flopKey = flop && flops.includes(flop) ? flop : (flops[0] ?? null);
  const chunkKey = lineId && flopKey ? `${setId}/${lineId}/${flopKey}` : "";

  // The chunk of the chosen line and flop.
  useEffect(() => {
    if (!chunkKey || !lineId || !flopKey) return;
    let live = true;
    void libraryLoader()!
      .load(setId, lineId, flopKey)
      .then((chunk) => {
        if (live) setLoaded(chunk ? { key: chunkKey, status: "ready", chunk } : { key: chunkKey, status: "error" });
      });
    return () => {
      live = false;
    };
  }, [chunkKey, setId, lineId, flopKey, attempt]);

  const chunk = loaded.key === chunkKey && loaded.status === "ready" ? loaded.chunk : null;
  const nodeIndex = chunk && chunk.result.nodes[node]?.kind === "action" ? node : 0;

  // The view in the address bar, so a link lands here.
  useEffect(() => {
    if (!lineId || !flopKey) return;
    router.replace(paths.solver({ set: setId, line: lineId, flop: flopKey, node: nodeIndex }), { scroll: false });
  }, [router, setId, lineId, flopKey, nodeIndex]);

  const shownFlops = texture ? flops.filter((f) => textureOf(f) === texture) : flops;

  return (
    <div className={styles.browser}>
      <div className={styles.controls}>
        <label className={styles.field}>
          <span>{t.table}</span>
          <select
            value={setId}
            onChange={(event) => {
              setSetId(event.target.value);
              setNode(0);
            }}
          >
            {SOLVER_SETS.map((id) => {
              const s = CHART_SETS.find((c) => c.id === id)!;
              return (
                <option key={id} value={id}>
                  {t.setName(s.players, s.stackBb)}
                </option>
              );
            })}
          </select>
        </label>
        <label className={styles.field}>
          <span>{t.line}</span>
          <select
            value={lineId ?? ""}
            disabled={solvedLines.length === 0}
            onChange={(event) => {
              setLine(event.target.value);
              setNode(0);
            }}
          >
            {solvedLines.map((l) => {
              const [oop, ip] = flopPlayersOf(l.key, lineSeats(l));
              return (
                <option key={l.id} value={l.id}>
                  {t.lineName(oop, ip, t.pots[l.pot] ?? l.pot)}
                </option>
              );
            })}
          </select>
        </label>
      </div>

      {!byLine ? (
        <p className={analysis.muted}>{t.loading}</p>
      ) : solvedLines.length === 0 ? (
        <p className={analysis.muted}>{t.setEmpty}</p>
      ) : (
        <>
          <section className={styles.flops} aria-label={t.flopsLabel}>
            <div className={styles.flopsHead}>
              <strong>{t.flop}</strong>
              <span className={analysis.muted}>{t.flopCount(flops.length)}</span>
              <div className={styles.chips} role="group">
                {[null, ...TEXTURES].map((x) => (
                  <button
                    key={x ?? "all"}
                    type="button"
                    className={`${styles.chip} ${texture === x ? styles.chipOn : ""}`}
                    aria-pressed={texture === x}
                    onClick={() => setTexture(x)}
                  >
                    {x ? t.textures[x] : t.textures.all}
                  </button>
                ))}
              </div>
            </div>
            <div className={styles.flopList}>
              {shownFlops.map((key) => (
                <button
                  key={key}
                  type="button"
                  className={`${styles.flopButton} ${key === flopKey ? styles.flopOn : ""}`}
                  aria-pressed={key === flopKey}
                  aria-label={key}
                  onClick={() => {
                    setFlop(key);
                    setNode(0);
                  }}
                >
                  <CardRow cards={flopCards(key)} size="xs" />
                </button>
              ))}
            </div>
          </section>

          {loaded.key === chunkKey && loaded.status === "error" ? (
            <div className={styles.notice}>
              <p>{t.loadError}</p>
              <button type="button" className="btn btn--sm" onClick={() => setAttempt((n) => n + 1)}>
                {t.retry}
              </button>
            </div>
          ) : chunk ? (
            <Decision chunk={chunk} index={nodeIndex} onGo={setNode} />
          ) : (
            <p className={analysis.muted}>{t.loading}</p>
          )}
        </>
      )}
    </div>
  );
}

function Decision({ chunk, index, onGo }: { chunk: FlopChunk; index: number; onGo: (node: number) => void }) {
  const t = useDict().solver;
  const view = useMemo(() => exploreNode(chunk, index), [chunk, index]);
  const history = useMemo(() => exploreHistory(chunk, index), [chunk, index]);
  const colours = actionClasses(view.actions);
  const labels = view.actions.map((a) => t.action(a.kind, a.sizePot, a.amount));

  return (
    <section className={styles.decision}>
      <div className={styles.spot}>
        <div className={styles.board}>
          <span className={analysis.muted}>{t.board}</span>
          <CardRow cards={chunk.result.board} size="sm" />
        </div>
        <nav className={styles.history} aria-label={t.history}>
          <button type="button" className={styles.step} disabled={index === 0} onClick={() => onGo(0)}>
            {t.start}
          </button>
          {history.map((step) => (
            <span key={step.node} className={styles.stepWrap}>
              <span aria-hidden="true">›</span>
              <button type="button" className={styles.step} onClick={() => onGo(step.node)}>
                {t.step(step.position, t.action(step.action.kind, step.action.sizePot, step.action.amount))}
              </button>
            </span>
          ))}
        </nav>
        <p className={styles.toAct}>
          <strong>{t.toAct(view.position)}</strong> <span className={analysis.muted}>{t.pot(view.pot, view.toCall)}</span>
        </p>
      </div>

      <div className={styles.actions} role="group" aria-label={t.actionsLabel}>
        {view.actions.map((action, a) => (
          <button
            key={action.label}
            type="button"
            className={styles.action}
            disabled={action.child < 0}
            title={action.ends ? t.ends[action.ends] : t.follow(labels[a])}
            onClick={() => action.child >= 0 && onGo(action.child)}
          >
            <span className={`${styles.actionBar} ${colours[a]}`} style={{ inlineSize: `${Math.max(2, view.totals[a].share * 100)}%` }} />
            <span className={styles.actionText}>
              <strong>{labels[a]}</strong>
              <span>{t.share(view.totals[a].share, view.totals[a].combos)}</span>
            </span>
          </button>
        ))}
      </div>

      <Grid key={`${chunk.header.line}/${chunk.header.flop}/${index}`} chunk={chunk} view={view} labels={labels} colours={colours} />

      <p className={analysis.muted}>
        {t.rangeValue(view.reach, view.value)} · {t.solvedTo(chunk.result.exploitabilityPct, chunk.result.iterations)}
      </p>
    </section>
  );
}

function Grid({
  chunk,
  view,
  labels,
  colours,
}: {
  chunk: FlopChunk;
  view: ExploreNode;
  labels: string[];
  colours: string[];
}) {
  const t = useDict().solver;
  const [focusIndex, setFocusIndex] = useState(0);
  const [hovered, setHovered] = useState<number | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const shown = hovered ?? picked;
  const detail = shown === null ? null : view.classes[shown];
  const combos = useMemo(
    () => (shown === null ? [] : classCombos(chunk, view.index, shown)),
    [chunk, view.index, shown],
  );
  // How full a cell is drawn: the share of the class's combos that reach the decision.
  const fill = (k: number) => {
    const c = view.classes[k];
    return c.combos > 0 ? Math.min(1, c.weight / c.combos) : 0;
  };

  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const row = Math.floor(index / 13);
    const col = index % 13;
    const next =
      event.key === "ArrowRight"
        ? row * 13 + Math.min(12, col + 1)
        : event.key === "ArrowLeft"
          ? row * 13 + Math.max(0, col - 1)
          : event.key === "ArrowDown"
            ? Math.min(12, row + 1) * 13 + col
            : event.key === "ArrowUp"
              ? Math.max(0, row - 1) * 13 + col
              : null;
    if (next === null) return;
    event.preventDefault();
    setFocusIndex(next);
    setPicked(next);
    buttons.current[next]?.focus();
  };

  return (
    <div className={analysis.chart}>
      <ul className={analysis.chartLegend} aria-label={t.actionsLabel}>
        {view.actions.map((action, a) => (
          <li key={action.label}>
            <span className={`${analysis.swatch} ${colours[a]}`} aria-hidden="true" />
            {t.total(labels[a], view.totals[a].share, view.totals[a].combos)}
          </li>
        ))}
      </ul>

      <div className={analysis.chartBody}>
        <div className={analysis.grid} role="grid" aria-label={t.gridLabel(view.position)}>
          {Array.from({ length: 13 }, (_, row) => (
            <div key={row} role="row" className={analysis.gridRow}>
              {GRID_CELLS.slice(row * 13, row * 13 + 13).map((cell, col) => {
                const index = row * 13 + col;
                const data = view.classes[index];
                const absent = data.combos === 0;
                const faint = !absent && data.weight === 0;
                const name = t.cellLabel(
                  cell.name,
                  data.freq.map((freq, a) => t.part(labels[a], freq)).filter((_, a) => data.freq[a] >= SHOWN_FREQ),
                  absent,
                );
                return (
                  <div key={cell.name} role="gridcell" className={analysis.gridCellWrap}>
                    <button
                      ref={(element) => {
                        buttons.current[index] = element;
                      }}
                      type="button"
                      tabIndex={index === focusIndex ? 0 : -1}
                      className={`${analysis.gridCell} ${styles.cell}${absent || faint ? ` ${analysis.offRange}` : ""}${
                        index === shown ? ` ${analysis.shownCell}` : ""
                      }`}
                      aria-label={name}
                      aria-pressed={index === picked}
                      onClick={() => {
                        setFocusIndex(index);
                        setPicked(index === picked ? null : index);
                      }}
                      onFocus={() => setFocusIndex(index)}
                      onKeyDown={(event) => move(event, index)}
                      onPointerEnter={() => setHovered(index)}
                      onPointerLeave={() => setHovered((current) => (current === index ? null : current))}
                    >
                      <span className={analysis.cellName}>{cell.name}</span>
                      {absent ? null : (
                        <span className={styles.cellFill} aria-hidden="true" style={{ blockSize: `${Math.max(12, fill(index) * 100)}%` }}>
                          {data.freq.map((freq, a) =>
                            freq > 0 ? <span key={a} className={colours[a]} style={{ inlineSize: `${freq * 100}%` }} /> : null,
                          )}
                        </span>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div className={analysis.chartDetail} aria-live="polite">
          {detail ? (
            <>
              <p className={analysis.chartDetailHead}>
                <strong>{GRID_CELLS[detail.index].name}</strong> {detail.combos > 0 ? t.value(detail.value) : null}
              </p>
              <p className={analysis.muted}>{detail.combos === 0 ? t.absent : t.reaches(detail.weight, detail.combos)}</p>
              {detail.combos > 0 ? (
                <>
                  <ul className={analysis.detailList}>
                    {view.actions.map((action, a) => (
                      <li key={action.label}>
                        <span className={`${analysis.swatch} ${colours[a]}`} aria-hidden="true" />
                        <span>{labels[a]}</span>
                        <span className={analysis.num}>{t.freq(detail.freq[a])}</span>
                        <span className={analysis.num}>{t.signedBb(detail.ev[a])}</span>
                      </li>
                    ))}
                  </ul>
                  <table className={styles.combos}>
                    <thead>
                      <tr>
                        <th scope="col">{t.combo}</th>
                        <th scope="col">{t.weight}</th>
                        {labels.map((label) => (
                          <th key={label} scope="col">
                            {label}
                          </th>
                        ))}
                        <th scope="col">{t.ev}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {combos.map((c) => (
                        <tr key={c.cards} className={c.weight === 0 ? styles.comboOut : ""}>
                          <th scope="row">
                            <ComboText cards={c.cards} />
                          </th>
                          <td className={analysis.num}>{t.freq(c.weight)}</td>
                          {c.freq.map((f, a) => (
                            <td key={a} className={analysis.num}>
                              {t.freq(f)}
                            </td>
                          ))}
                          <td className={analysis.num}>{t.signedBb(c.value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              ) : null}
            </>
          ) : (
            <p className={analysis.muted}>{t.detailEmpty}</p>
          )}
          <p className={analysis.muted}>{t.rangeNote}</p>
        </div>
      </div>
    </div>
  );
}

/** Two cards as text, `K♠Q♦`: compact enough for a table row, the glyph naming the suit. */
function ComboText({ cards }: { cards: string }) {
  return (
    <span className={styles.comboText}>
      {[cards.slice(0, 2), cards.slice(2, 4)].map((card) => {
        const suit = card[1] as Suit;
        return (
          <span key={card} className={isRedSuit(suit) ? styles.red : undefined}>
            {card[0]}
            {SUIT_SYMBOL[suit]}
          </span>
        );
      })}
    </span>
  );
}
