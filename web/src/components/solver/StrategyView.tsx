/**
 * One decision as a solver's viewer shows it ("Studio"): the 13×13 grid on
 * the left, the panel on the right (under the grid on a narrow screen). The
 * same view for a preflop chart node and a flop decision of the library: the
 * caller builds the model (`preflopModel`, `flopModel` in
 * `SolverLibrary.tsx`). The line is walked on the action strip above
 * (PreflopBar, PostflopBar).
 *
 * Each cell is the class's mix drawn as coloured columns, as tall as the
 * share of the class that reaches the decision. The panel: who acts and the
 * pot (`overview`), the strategy as one stacked bar, and a row per action -
 * its colour, its name (a lock mark, GTO's share when comparing), the combos,
 * the share and its EV, signed. Hovering a row shows only that action in the
 * grid, a click keeps it lit. Under them `Hand | Filters`: the hovered (or
 * picked) hand - its name, what it makes on the board, its EV - as combo
 * cards (`@rail/ui` ComboZoom, GTO Wizard's look): each filled with its mix as
 * bands (as tall as its reach), every action's frequency and EV; a combo the
 * board takes out stays as a hatched card, so the blockers show. The panel
 * is where a hovered hand shows: only while it is on `Filters` does hovering
 * a cell zoom it over the grid instead (the class box and its combos under it).
 * The hero's hand, when the view comes from one of their decisions, is marked
 * in the grid and on its card.
 *
 * Accessibility as in the chart browser's grid: one tab stop with arrow
 * keys, every cell a button that reads its mix in words, the detail a polite
 * live region; every tile reads its mix too.
 */

"use client";

import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ComboCards, GridZoom, aggressiveFirst, zoomAnchor, type ZoomAction, type ZoomAnchor, type ZoomCombo } from "@rail/ui/charts/ComboZoom";
import { SUIT_SYMBOL, type Suit } from "../../lib/cards";
import { useSolverDict, type StrategyCompare } from "./host";
import type { ExploreCombo } from "../../lib/solver";
import { GRID_CELLS } from "../analysis/chartSpots";
import analysis from "../analysis/analysis.module.css";
import { MixBar, SignedBb } from "./ui";
import styles from "./solver.module.css";

export interface ViewAction {
  key: string;
  label: string;
  /** As a combo tile writes it: `X`, `B33`, `R8.5`. */
  short: string;
  /** `actionColours`. */
  colour: string;
  share: number;
  combos: number;
  /** EV of the action over the hands that take it, bb; null when none does. */
  ev: number | null;
  /** No hand of the range takes it (`playedOptions`): left out of the action boxes and the EV rows. */
  hidden?: boolean;
  /** `bet`, `raise`, `check`…, and its amount in bb: the hover lists the bets biggest first. */
  kind?: string;
  amount?: number;
  /** A bet's size in bb after its label on the hover, `(4.1)`. */
  size?: string | null;
}

export interface ViewClass {
  /** `in` the range, `faint` (in the tree, never reached), or `absent` (no combo of it here). */
  state: "in" | "faint" | "absent";
  /** How much of the class reaches the decision, 0..1: the height of its columns. */
  fill: number;
  freq: number[];
  ev: number[];
  value: number;
}

export interface StrategyModel {
  /** Changes with the decision: the picked hand resets. */
  id: string;
  actor: string;
  actions: ViewAction[];
  classes: ViewClass[];
  /** A class's combos (flop decisions only), in the picked suits. */
  combos?: (classIndex: number) => ExploreCombo[];
  /** Combos of the range that reach the decision, through the hand filter (postflop): none leaves the grid empty. */
  reach?: number;
  /** The board in the picked suits (postflop): a combo it takes out reads "blocked by the board". */
  board?: readonly string[];
  /** What a class makes on the board, most of its combos (postflop), or null. */
  category?: (classIndex: number) => string | null;
}

/** The hero's hand, when the view comes from one of their decisions: marked where `position` acts. */
export interface StrategyHero {
  /** Two cards, `Qs9s`. */
  cards: string;
  position: string;
}

/** Below this an action rounds to nothing (it reads `<0.1%`): left out of a cell's spoken mix. */
const SHOWN_FREQ = 0.0005;
/** An action row being hovered leaves the others this faint in the grid. */
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

/**
 * A hand hovered in another tab's view: the acting player's class opens in the
 * panel as on the grid (`index`); anything else brings its own `panel`.
 */
export type MainHand = { index: number } | { panel: ReactNode };

interface StrategyViewProps {
  model: StrategyModel;
  /** The panel's first line: who acts and the pot. */
  overview: ReactNode;
  /**
   * In the grid's place: another tab's view (the Ranges tab). As a function it
   * is handed `onHand`, so hovering a hand there opens it in the panel.
   */
  main?: ReactNode | ((onHand: (hand: MainHand | null) => void) => ReactNode);
  /** In the grid's place when the hand filter leaves no hand: the message and its way out. */
  empty?: ReactNode;
  /** The hand filters: the panel's last block then switches between the hand and them. */
  filters?: ReactNode;
  /** The tab was just switched: the grid (or `main`) fades in as it swaps. */
  fade?: boolean;
  /** The hero's hand: marked, and shown first, when their position acts. */
  hero?: StrategyHero | null;
  /** A baseline at the same decision (the app's nodelock: GTO beside the locked solve): its deltas show. */
  compare?: StrategyCompare | null;
  /** After an action's label (by its `key`): the app's nodelock marks a locked action. */
  actionMark?: (key: string) => ReactNode;
}

export function StrategyView({ model, overview, main, empty, filters, fade = false, hero = null, compare = null, actionMark }: StrategyViewProps) {
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
        main={main}
        empty={empty}
        filters={filters}
        fade={fade}
        hero={hero}
        compare={compare}
        actionMark={actionMark}
        panelTab={panelTab}
        onPanelTab={setPanelTab}
      />
    </div>
  );
}

function Grid({
  model,
  overview,
  main,
  empty,
  filters,
  fade,
  hero,
  compare,
  actionMark,
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
  /** The hovered cell measured for the zoom (GTO Wizard's hover), cleared on leaving the grid. */
  const [anchor, setAnchor] = useState<ZoomAnchor | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<number | null>(heroIndex);
  const [hoveredAction, setHoveredAction] = useState<number | null>(null);
  /** An action row clicked: only that action stays lit in the grid until it is clicked again. */
  const [pinned, setPinned] = useState<number | null>(null);
  const highlight = hoveredAction ?? pinned;
  /** The hand block's content brought by another tab's view (the other player's hand on the Ranges tab). */
  const [aside, setAside] = useState<ReactNode | null>(null);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const shown = hovered ?? picked;
  const detail = shown === null ? null : model.classes[shown];
  const tiles = useMemo(() => (shown === null ? [] : tilesOf(model, shown)), [model, shown]);
  const labels = model.actions.map((a) => a.label);
  const colours = model.actions.map((a) => a.colour);
  const zoomActions = useMemo<ZoomAction[]>(
    () => model.actions.map((a) => ({ label: a.label, size: a.size, className: a.colour, hidden: a.hidden })),
    [model.actions],
  );
  const order = useMemo(() => aggressiveFirst(model.actions.map((a) => ({ kind: a.kind ?? "", size: a.amount }))), [model.actions]);
  const words = { combos: t.zoom.combos, you: t.you, ev: t.ev };
  const onHand = useCallback((hand: MainHand | null) => {
    if (hand && "panel" in hand) {
      setHovered(null);
      setAside(hand.panel);
    } else {
      setAside(null);
      setHovered(hand ? hand.index : null);
    }
  }, []);
  const mainView = typeof main === "function" ? main(onHand) : main;

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

  const showFilters = Boolean(filters) && panelTab === "filters";
  const isHeroTile = (cards: string) => shown === heroIndex && !!hero && sameCombo(hero.cards, cards);
  const visible = model.actions.map((action) => (action.hidden ? 0 : action.share));
  const category = shown !== null && detail?.state !== "absent" ? (model.category?.(shown) ?? null) : null;

  let left: ReactNode;
  if (mainView) left = fade ? <div className="rail-fade">{mainView}</div> : mainView;
  else if (empty) left = empty;
  else
    left = (
      <div
        className={`${styles.grid} ${fade ? "rail-fade" : ""}`}
        role="grid"
        aria-label={t.gridLabel(model.actor)}
        onPointerLeave={() => {
          setHovered(null);
          setAnchor(null);
        }}
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
                index === picked ? styles.cellPicked : "",
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
                    }}
                    onFocus={() => setFocusIndex(index)}
                    onKeyDown={(event) => move(event, index)}
                    onPointerEnter={(event) => {
                      setHovered(index);
                      if (wrapRef.current) setAnchor(zoomAnchor(index, event.currentTarget, wrapRef.current));
                    }}
                  >
                    {data.state === "absent" ? null : (
                      <span className={styles.cellFill} aria-hidden="true" style={{ blockSize: `${Math.max(10, data.fill * 100)}%` }}>
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
    );

  return (
    <>
      <div ref={wrapRef} className={`${styles.gridWrap} ${styles.gridZoomWrap}`}>
        {left}
        {/* The panel's Hand block already shows the hovered hand: the zoom only while the panel is on the filters. */}
        {showFilters && anchor && !mainView && !empty && anchor.cell === hovered ? <Zoom model={model} anchor={anchor} actions={zoomActions} order={order} words={words} hero={hero && heroIndex === anchor.cell ? hero.cards : null} /> : null}
      </div>

      <aside className={styles.panel}>
        {overview}
        <MixBar mix={visible} colours={colours} />

        <div className={styles.acts} role="group" aria-label={t.panel.actions}>
          {model.actions.map((action, a) =>
            action.hidden ? null : (
              <button
                key={action.key}
                type="button"
                className={`${styles.act} ${highlight === a ? styles.actOn : ""} ${highlight !== null && highlight !== a ? styles.actOff : ""}`}
                aria-pressed={pinned === a}
                onClick={() => setPinned(pinned === a ? null : a)}
                onPointerEnter={() => setHoveredAction(a)}
                onPointerLeave={() => setHoveredAction(null)}
                onFocus={() => setHoveredAction(a)}
                onBlur={() => setHoveredAction(null)}
              >
                <span className={`${styles.actDot} ${action.colour}`} aria-hidden="true" />
                <span className={styles.actLabel}>
                  {action.label}
                  {actionMark ? actionMark(action.key) : null}
                  {compare ? (
                    <span className={styles.actGto} title={compare.shareDelta(action.share - (compare.shares[a] ?? 0))}>
                      {compare.label} {t.shareOnly(compare.shares[a] ?? 0)}
                    </span>
                  ) : null}
                </span>
                <span className={styles.actCombos}>{t.count(action.combos)}</span>
                <span className={styles.actShare}>{t.shareOnly(action.share)}</span>
                {action.ev === null ? <span /> : <SignedBb className={styles.actEv} value={action.ev} text={t.signed(action.ev)} />}
              </button>
            ),
          )}
        </div>

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
          <section aria-label={t.filters.title}>{filters}</section>
        ) : (
          <section className={styles.handBlock} aria-live="polite" aria-label={t.panel.hand}>
            {aside ? (
              aside
            ) : detail && shown !== null ? (
              <>
                <p className={styles.handHead}>
                  <strong className={styles.handName}>{GRID_CELLS[shown].name}</strong>
                  {category ? <span className={styles.handCat}>{category}</span> : null}
                  {shown === heroIndex ? <span className={styles.youTag}>{t.yourHand}</span> : null}
                  {detail.state === "absent" ? null : (
                    <>
                      <SignedBb className={styles.handValue} value={detail.value} text={t.signedBb(detail.value)} />
                      {compare ? (
                        <span className={styles.handDelta}>
                          {t.vsBase(t.signedBb(detail.value - compare.classes[shown].value), compare.label)}
                        </span>
                      ) : null}
                    </>
                  )}
                </p>
                {detail.state === "absent" ? (
                  <p className={analysis.muted}>{t.absent}</p>
                ) : (
                  <ComboCards
                    label={t.combosLabel}
                    combos={tiles.map((x) => panelCombo(x, model, isHeroTile(x.cards), t))}
                    actions={zoomActions}
                    order={order}
                    words={words}
                    withEv
                  />
                )}
              </>
            ) : (
              <p className={analysis.muted}>{t.detailEmpty}</p>
            )}
          </section>
        )}
      </aside>
    </>
  );
}

/** A tile of the panel as a combo card: its mix, EV and reach, or why it is not here. */
function panelCombo(tile: Tile, model: StrategyModel, hero: boolean, t: ReturnType<typeof useSolverDict>): ZoomCombo {
  const combo = tile.combo;
  if (!combo) {
    const board = model.board ?? null;
    const blocked = board !== null && (board.includes(tile.cards.slice(0, 2)) || board.includes(tile.cards.slice(2, 4)));
    return { cards: tile.cards, freq: [], off: blocked ? t.blocked : t.comboOff, label: `${tile.cards}: ${blocked ? t.blocked : t.comboOff}` };
  }
  const parts = combo.freq.map((f, a) => (f >= SHOWN_FREQ ? t.part(model.actions[a].label, f) : null)).filter((p): p is string => p !== null);
  return {
    cards: tile.cards,
    freq: combo.freq,
    ev: combo.ev,
    reach: combo.weight,
    you: hero,
    label: t.tileLabel(tile.cards, parts, t.value(combo.value)),
  };
}

/**
 * The hover while the panel shows the filters: the class zoomed over its cell, its combos that reach the
 * decision under it (flop decisions: preflop every combo plays the class's
 * mix, so the class box shows alone).
 */
function Zoom({
  model,
  anchor,
  actions,
  order,
  words,
  hero,
}: {
  model: StrategyModel;
  anchor: ZoomAnchor;
  actions: ZoomAction[];
  order: number[];
  words: { combos: (n: number) => string; you: string };
  hero: string | null;
}) {
  const data = model.classes[anchor.cell];
  if (!data || data.state === "absent") return null;
  const name = GRID_CELLS[anchor.cell].name;
  const listed = model.combos ? model.combos(anchor.cell).filter((c) => c.weight > 0) : null;
  const combos: ZoomCombo[] = (listed ?? [])
    .map((c) => ({ cards: c.cards, freq: c.freq, you: hero !== null && sameCombo(hero, c.cards) }))
    .sort((x, y) => allCombos(name).findIndex((c) => sameCombo(c, x.cards)) - allCombos(name).findIndex((c) => sameCombo(c, y.cards)));
  const count = listed ? listed.length : Math.round(allCombos(name).length * data.fill * 10) / 10;
  return <GridZoom anchor={anchor} name={name} count={count} freq={data.freq} combos={combos} actions={actions} order={order} words={words} />;
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
