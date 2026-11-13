/**
 * One decision as a solver's viewer shows it: the 13×13 grid on the left, the
 * actions and the picked hand on the right (under the grid on a narrow
 * screen). The same view for a preflop chart node and a flop decision of the
 * library: the caller builds the model (`preflopModel`, `flopModel` in
 * `SolverLibrary.tsx`).
 *
 * Each cell is the class's mix drawn as coloured columns, as tall as the
 * share of the class that reaches the decision. Hovering an action box shows
 * only that action in the grid. The picked (or hovered) hand opens as tiles,
 * one per combo, each filled bottom-up with its own mix and as tall as its
 * weight: what every combo does at a glance, the exact numbers on hovering a
 * tile. A combo the board (or a hand filter) takes out stays as a hatched
 * tile, so the blockers show. The hero's hand, when the view comes from one
 * of their decisions, is marked in the grid and on its tile.
 *
 * Accessibility as in the chart browser's grid: one tab stop with arrow
 * keys, every cell a button that reads its mix in words, the detail a polite
 * live region; every tile reads its mix too.
 */

"use client";

import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { SUIT_SYMBOL, type Suit } from "../../lib/cards";
import { useSolverDict } from "./host";
import type { ExploreCombo } from "../../lib/solver";
import { GRID_CELLS } from "../analysis/chartSpots";
import analysis from "../analysis/analysis.module.css";
import styles from "./solver.module.css";

export interface ViewAction {
  key: string;
  label: string;
  /** `actionColours`. */
  colour: string;
  share: number;
  combos: number;
  /** Why the action leads nowhere further, if it does not. */
  ends: string | null;
  onPick: () => void;
}

export interface ViewClass {
  /** `in` the range, `faint` (in the tree, never reached), or `absent` (no combo of it here). */
  state: "in" | "faint" | "absent";
  /** How much of the class reaches the decision, 0..1: the height of its columns. */
  fill: number;
  freq: number[];
  ev: number[];
  value: number;
  /** The reach line of the detail. */
  reach: string;
}

export interface StrategyModel {
  /** Changes with the decision: the picked hand resets. */
  id: string;
  actor: string;
  actions: ViewAction[];
  classes: ViewClass[];
  /** A class's combos (flop decisions only), in the picked suits. */
  combos?: (classIndex: number) => ExploreCombo[];
  note: string;
}

/** The hero's hand, when the view comes from one of their decisions: marked where `position` acts. */
export interface StrategyHero {
  /** Two cards, `Qs9s`. */
  cards: string;
  position: string;
}

/** Below this an action rounds to nothing (it reads `<0.1%`): left out of a cell's spoken mix. */
const SHOWN_FREQ = 0.0005;
/** An action box being hovered leaves the others this faint in the grid. */
const DIMMED = 0.12;
const RANKS = "AKQJT98765432";
const SUITS: Suit[] = ["s", "h", "d", "c"];

/**
 * The colour of each action: bets and raises darken with size, so two sizes
 * never look alike; the largest is the full raise colour.
 */
export function actionColours(actions: ReadonlyArray<{ kind: string; amount: number }>): string[] {
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
        return styles[`lighter${Math.min(2, shade.get(a) ?? 0)}`] ?? analysis.actRaise;
    }
  });
}

/** `AKs` / `AKo` / `AA` of two cards (`Qs9s`), or null when they are not two cards. */
export function classOfCards(cards: string): string | null {
  if (cards.length !== 4) return null;
  const [r1, s1, r2, s2] = cards;
  const i = RANKS.indexOf(r1);
  const j = RANKS.indexOf(r2);
  if (i < 0 || j < 0) return null;
  const [hi, lo] = i <= j ? [r1, r2] : [r2, r1];
  return hi === lo ? `${hi}${lo}` : `${hi}${lo}${s1 === s2 ? "s" : "o"}`;
}

/** The same two cards in either order. */
function sameCombo(a: string, b: string): boolean {
  return a === b || a === `${b.slice(2, 4)}${b.slice(0, 2)}`;
}

/** Every combo of a class, higher card first, in one fixed suit order: the tiles keep their places. */
function allCombos(name: string): string[] {
  const [hi, lo, kind] = name;
  const out: string[] = [];
  SUITS.forEach((s1, a) =>
    SUITS.forEach((s2, b) => {
      const take = hi === lo ? b > a : kind === "s" ? a === b : a !== b;
      if (take) out.push(`${hi}${s1}${lo}${s2}`);
    }),
  );
  return out;
}

/** One tile: a combo of the shown class, or one this spot does not have (`combo` null: on the board, or filtered out). */
interface Tile {
  cards: string;
  combo: ExploreCombo | null;
}

/**
 * The shown class's tiles. A flop decision has each combo's own strategy;
 * preflop every combo plays the class's mix, at the class's reach.
 */
function tilesOf(model: StrategyModel, index: number): Tile[] {
  const name = GRID_CELLS[index].name;
  const data = model.classes[index];
  if (!model.combos) {
    if (data.state === "absent") return [];
    return allCombos(name).map((cards) => ({
      cards,
      combo: { cards, weight: data.fill, freq: data.freq, ev: data.ev, value: data.value },
    }));
  }
  const listed = model.combos(index);
  return allCombos(name).map((cards) => ({ cards, combo: listed.find((c) => sameCombo(c.cards, cards)) ?? null }));
}

function dominant(freq: readonly number[]): number {
  let best = 0;
  freq.forEach((f, a) => {
    if (f > freq[best]) best = a;
  });
  return best;
}

interface StrategyViewProps {
  model: StrategyModel;
  overview: ReactNode;
  /** Above the grid: the tabs of a flop decision. */
  toolbar?: ReactNode;
  /** In the grid's place: another tab's view (the Ranges tab). */
  main?: ReactNode;
  /** The hand filters: the panel's last block then switches between the hand and them. */
  filters?: ReactNode;
  /** The tab was just switched: the grid (or `main`) fades in as it swaps. */
  fade?: boolean;
  /** The hero's hand: marked, and shown first, when their position acts. */
  hero?: StrategyHero | null;
}

export function StrategyView({ model, overview, toolbar, main, filters, fade = false, hero = null }: StrategyViewProps) {
  // Kept across decisions: the panel stays on the filters while the line is walked.
  const [panelTab, setPanelTab] = useState<"hand" | "filters">("hand");
  // `rail-fade` plays once, when the view first replaces a loader or a message;
  // walking the tree re-renders it in place and does not replay it.
  return (
    <div className={`${styles.strategy} ${main ? styles.strategyWide : ""} rail-fade`}>
      <Grid
        key={model.id}
        model={model}
        overview={overview}
        toolbar={toolbar}
        main={main}
        filters={filters}
        fade={fade}
        hero={hero}
        panelTab={panelTab}
        onPanelTab={setPanelTab}
      />
    </div>
  );
}

function Grid({
  model,
  overview,
  toolbar,
  main,
  filters,
  fade,
  hero,
  panelTab,
  onPanelTab,
}: StrategyViewProps & { panelTab: "hand" | "filters"; onPanelTab: (tab: "hand" | "filters") => void }) {
  const t = useSolverDict();
  const heroIndex = useMemo(() => {
    if (!hero || hero.position !== model.actor) return null;
    const name = classOfCards(hero.cards);
    const at = GRID_CELLS.findIndex((cell) => cell.name === name);
    return at >= 0 ? at : null;
  }, [hero, model.actor]);
  const [focusIndex, setFocusIndex] = useState(heroIndex ?? 0);
  const [hovered, setHovered] = useState<number | null>(null);
  const [picked, setPicked] = useState<number | null>(heroIndex);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [tile, setTile] = useState<number | null>(null);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const shown = hovered ?? picked;
  const detail = shown === null ? null : model.classes[shown];
  const tiles = useMemo(() => (shown === null ? [] : tilesOf(model, shown)), [model, shown]);
  const labels = model.actions.map((a) => a.label);
  const showHover = (index: number) => {
    setHovered(index);
    setTile(null);
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
    setTile(null);
    buttons.current[next]?.focus();
  };

  const showFilters = Boolean(filters) && panelTab === "filters";
  const isHeroTile = (cards: string) => shown === heroIndex && !!hero && sameCombo(hero.cards, cards);
  const focused = tile !== null ? tiles[tile]?.combo ?? null : null;
  const live = tiles.filter((x) => x.combo && x.combo.weight > 0).length;
  const columns = tiles.length <= 4 ? 2 : tiles.length <= 6 ? 3 : 4;

  return (
    <>
      <div className={styles.gridWrap}>
        {toolbar}
        {main ? (
          fade ? <div className="rail-fade">{main}</div> : main
        ) : (
        <div
          className={`${styles.grid} ${fade ? "rail-fade" : ""}`}
          role="grid"
          aria-label={t.gridLabel(model.actor)}
          onPointerLeave={() => setHovered(null)}
        >
          {Array.from({ length: 13 }, (_, row) => (
            <div key={row} role="row" className={styles.gridRow}>
              {GRID_CELLS.slice(row * 13, row * 13 + 13).map((cell, col) => {
                const index = row * 13 + col;
                const data = model.classes[index];
                const name = t.cellLabel(
                  cell.name,
                  data.freq.map((freq, a) => t.part(labels[a], freq)).filter((_, a) => data.freq[a] >= SHOWN_FREQ),
                  data.state === "absent",
                );
                const classes = [
                  styles.cell,
                  data.state !== "in" ? styles.cellFaint : "",
                  index === hovered ? styles.cellHover : "",
                  index === picked && index !== hovered ? styles.cellPicked : "",
                  index === heroIndex ? styles.cellHero : "",
                ];
                return (
                  <div key={cell.name} role="gridcell" className={styles.gridCellWrap}>
                    <button
                      ref={(element) => {
                        buttons.current[index] = element;
                      }}
                      type="button"
                      tabIndex={index === focusIndex ? 0 : -1}
                      className={classes.filter(Boolean).join(" ")}
                      aria-label={index === heroIndex ? `${name} · ${t.yourHand}` : name}
                      aria-pressed={index === picked}
                      onClick={() => {
                        setFocusIndex(index);
                        setPicked(index === picked ? null : index);
                        setTile(null);
                      }}
                      onFocus={() => setFocusIndex(index)}
                      onKeyDown={(event) => move(event, index)}
                      onPointerEnter={() => showHover(index)}
                    >
                      {data.state === "absent" ? null : (
                        <span className={styles.cellFill} aria-hidden="true" style={{ blockSize: `${Math.max(8, data.fill * 100)}%` }}>
                          {data.freq.map((freq, a) =>
                            freq > 0 ? (
                              <span
                                key={a}
                                className={model.actions[a].colour}
                                style={{ inlineSize: `${freq * 100}%`, opacity: highlight === null || highlight === a ? 1 : DIMMED }}
                              />
                            ) : null,
                          )}
                        </span>
                      )}
                      <span className={styles.cellName}>{cell.name}</span>
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        )}
      </div>

      <aside className={styles.panel}>
        <section className={styles.panelBlock}>{overview}</section>

        <section className={styles.panelBlock} aria-label={t.panel.actions}>
          <div className={styles.actionBoxes}>
            {model.actions.map((action, a) => (
              <button
                key={action.key}
                type="button"
                className={`${styles.actionBox} ${highlight === a ? styles.actionBoxOn : ""} ${highlight !== null && highlight !== a ? styles.actionBoxOff : ""}`}
                aria-disabled={action.ends !== null}
                title={action.ends ?? t.panel.follow(action.label)}
                onClick={() => {
                  if (action.ends === null) action.onPick();
                }}
                onPointerEnter={() => setHighlight(a)}
                onPointerLeave={() => setHighlight(null)}
                onFocus={() => setHighlight(a)}
                onBlur={() => setHighlight(null)}
              >
                <span className={styles.actionBoxLabel}>
                  <span className={`${styles.actionDot} ${action.colour}`} aria-hidden="true" />
                  {action.label}
                </span>
                <strong className={styles.actionBoxShare}>{t.shareOnly(action.share)}</strong>
                <span className={styles.actionBoxCombos}>{t.combosCount(action.combos)}</span>
                <span className={styles.actionTrack} aria-hidden="true">
                  <span className={action.colour} style={{ inlineSize: `${action.share * 100}%` }} />
                </span>
              </button>
            ))}
          </div>
        </section>

        {filters ? (
          <div className={styles.panelTabs} role="tablist" aria-label={t.filters.title}>
            {(["hand", "filters"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={panelTab === tab}
                className={styles.panelTab}
                onClick={() => onPanelTab(tab)}
              >
                {tab === "hand" ? t.filters.hand : t.filters.title}
              </button>
            ))}
          </div>
        ) : null}

        {showFilters ? (
          <section className={styles.panelBlock} aria-label={t.filters.title}>
            {filters}
          </section>
        ) : (
        <section className={`${styles.panelBlock} ${styles.handBlock}`} aria-live="polite" aria-label={t.panel.hand}>
          {detail && shown !== null ? (
            <>
              <p className={styles.handHead}>
                <strong className={styles.handName}>{GRID_CELLS[shown].name}</strong>
                {shown === heroIndex ? <span className={styles.youTag}>{t.yourHand}</span> : null}
                {detail.state === "absent" ? null : <span className={styles.handValue}>{t.value(detail.value)}</span>}
              </p>
              {detail.state === "absent" ? (
                <p className={analysis.muted}>{t.absent}</p>
              ) : (
                <>
                  <span className={styles.mixBar} aria-hidden="true">
                    {detail.freq.map((f, a) => (
                      <span key={a} className={model.actions[a].colour} style={{ inlineSize: `${f * 100}%` }} />
                    ))}
                  </span>
                  <EvRows actions={model.actions} ev={detail.ev} freq={detail.freq} />
                  <ul
                    className={styles.tiles}
                    style={{ "--tile-columns": columns } as CSSProperties}
                    aria-label={t.combosLabel}
                    onPointerLeave={() => setTile(null)}
                  >
                    {tiles.map((x, i) => (
                      <ComboTile
                        key={x.cards}
                        tile={x}
                        actions={model.actions}
                        hero={isHeroTile(x.cards)}
                        onHover={() => setTile(i)}
                      />
                    ))}
                  </ul>
                  <p className={styles.tileInfo}>
                    {focused ? (
                      <>
                        <ComboText cards={focused.cards} />
                        {focused.weight < 0.995 ? <span>{t.inRange(focused.weight)}</span> : null}
                      </>
                    ) : (
                      <span>{t.combosCount(live)}</span>
                    )}
                    {(focused ?? detail).freq.map((f, a) =>
                      f >= SHOWN_FREQ ? (
                        <span key={a} className={styles.tilePart}>
                          <span className={`${analysis.swatch} ${model.actions[a].colour}`} aria-hidden="true" />
                          {model.actions[a].label} <strong>{t.freq(f)}</strong>
                        </span>
                      ) : null,
                    )}
                    <span className={styles.tileEv}>{t.value(focused ? focused.value : detail.value)}</span>
                  </p>
                  <p className={analysis.muted}>{detail.reach}</p>
                </>
              )}
            </>
          ) : (
            <p className={analysis.muted}>{t.detailEmpty}</p>
          )}
          <p className={analysis.muted}>{model.note}</p>
        </section>
        )}
      </aside>
    </>
  );
}

/** What each action is worth for the shown hand, as bars from zero; the best one stands out. */
function EvRows({ actions, ev, freq }: { actions: ViewAction[]; ev: number[]; freq: number[] }) {
  const t = useSolverDict();
  const lo = Math.min(0, ...ev);
  const hi = Math.max(0, ...ev);
  const span = hi - lo || 1;
  const zero = (-lo / span) * 100;
  const best = ev.indexOf(Math.max(...ev));
  return (
    <ul className={styles.evRows}>
      {actions.map((action, a) => {
        const width = (Math.abs(ev[a]) / span) * 100;
        return (
          <li key={action.key} className={a === best ? styles.evBest : ""}>
            <span>{action.label}</span>
            <span className={styles.evBar} aria-hidden="true">
              <span className={styles.evZero} style={{ insetInlineStart: `${zero}%` }} />
              <span
                className={action.colour}
                style={{ insetInlineStart: `${ev[a] >= 0 ? zero : zero - width}%`, inlineSize: `${width}%`, opacity: freq[a] >= SHOWN_FREQ ? 1 : 0.5 }}
              />
            </span>
            <span className={analysis.num}>{t.signedBb(ev[a])}</span>
          </li>
        );
      })}
    </ul>
  );
}

function ComboTile({ tile, actions, hero, onHover }: { tile: Tile; actions: ViewAction[]; hero: boolean; onHover: () => void }) {
  const t = useSolverDict();
  const combo = tile.combo;
  if (!combo) {
    return (
      <li className={`${styles.tile} ${styles.tileOff}`} aria-label={`${tile.cards}: ${t.comboOff}`}>
        <span className={styles.tileCards}>
          <ComboText cards={tile.cards} />
        </span>
        <span className={styles.tileOffText}>{t.comboOff}</span>
      </li>
    );
  }
  const top = dominant(combo.freq);
  const parts = combo.freq.map((f, a) => (f >= SHOWN_FREQ ? t.part(actions[a].label, f) : null)).filter((p): p is string => p !== null);
  return (
    <li
      className={`${styles.tile} ${combo.weight === 0 ? styles.tileFaint : ""} ${hero ? styles.tileHero : ""}`}
      aria-label={t.tileLabel(tile.cards, parts, t.value(combo.value))}
      onPointerEnter={onHover}
    >
      <span className={styles.tileFill} aria-hidden="true" style={{ blockSize: `${combo.weight > 0 ? Math.max(10, combo.weight * 100) : 10}%` }}>
        {combo.freq.map((f, a) => (
          <span key={a} className={actions[a].colour} style={{ blockSize: `${f * 100}%` }} />
        ))}
      </span>
      <span className={styles.tileCards}>
        <ComboText cards={tile.cards} />
      </span>
      {hero ? <span className={styles.tileYou}>{t.you}</span> : null}
      <span className={styles.tileTop}>
        {t.freq(combo.freq[top])}
        <small>{actions[top].label}</small>
      </span>
    </li>
  );
}

/**
 * Two cards as text, `K♠Q♦`: compact enough for a table row, the glyph naming the suit.
 * Four colours like the board's cards: at text size ♦ and ♥ are hard to tell apart in one red.
 */
const SUIT_TEXT_CLASS: Record<Suit, string | undefined> = {
  s: undefined,
  h: styles.comboSuitH,
  d: styles.comboSuitD,
  c: styles.comboSuitC,
};

export function ComboText({ cards }: { cards: string }) {
  return (
    <span className={styles.comboText}>
      {[cards.slice(0, 2), cards.slice(2, 4)].map((card) => {
        const suit = card[1] as Suit;
        return (
          <span key={card} className={SUIT_TEXT_CLASS[suit]}>
            {card[0]}
            {SUIT_SYMBOL[suit]}
          </span>
        );
      })}
    </span>
  );
}
