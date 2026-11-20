/**
 * The hero's range at the decision as a 13×13 grid: every class shaded by
 * how much of it reaches the node and - with the strategy shown - split into
 * the reference's actions, the bets on the left and the passive play on the
 * right, as GTO Wizard draws it. The hero's class is ringed.
 *
 * Hovering a class zooms it (canvas `ideas-trainer` A): the class with every
 * action's frequency, and under it each of its combos that reach the node,
 * with its own mix (postflop, where the reference plays combos apart). Under
 * the grid, each action's share of the range as a button: picking one shows
 * only the hands that take it.
 */

"use client";

import { useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { GridZoom, zoomAnchor, type ZoomAction, type ZoomAnchor } from "@rail/ui/charts/ComboZoom";
import type { RangeCombo, RangeView } from "../../lib/training/rangeView";
import { useTrainerHost } from "./host";
import styles from "./trainer.module.css";

/** Every two-card hand: the share of them the range holds. */
const ALL_COMBOS = 1326;
const SUITS: Record<string, string> = { s: "♠", h: "♥", d: "♦", c: "♣" };
const SUIT_ORDER = "shdc";

type Option = RangeView["options"][number];

const toneOf = (option: Option) => (option.allIn ? "allin" : option.action);

/**
 * The options in display order, most aggressive first: all-in, the bets and
 * raises from the biggest down, then call, check, fold.
 */
export function displayOrder(options: readonly Option[]): number[] {
  const rank = (o: Option) =>
    o.allIn ? 0 : o.action === "bet" || o.action === "raise" ? 1 : o.action === "call" ? 2 : o.action === "check" ? 3 : 4;
  return options
    .map((_, a) => a)
    .sort((a, b) => rank(options[a]) - rank(options[b]) || (options[b].sizeBb ?? 0) - (options[a].sizeBb ?? 0));
}

/** Each option's colour: bigger bets darker, as the strategy bars draw them. */
export function optionColours(options: readonly Option[]): string[] {
  const sized = options
    .map((o, a) => ({ o, a }))
    .filter(({ o }) => !o.allIn && (o.action === "bet" || o.action === "raise"))
    .sort((x, y) => (x.o.sizeBb ?? 0) - (y.o.sizeBb ?? 0));
  return options.map((o, a) => {
    const tone = toneOf(o);
    if (tone === "fold") return "var(--chart-fold)";
    if (tone === "check") return "var(--chart-check)";
    if (tone === "call") return "var(--chart-call)";
    if (tone === "allin") return "var(--chart-allin)";
    const step = sized.findIndex((s) => s.a === a);
    return step <= 0 ? "var(--chart-raise)" : `color-mix(in srgb, var(--chart-raise) ${Math.max(45, 100 - step * 20)}%, var(--pcard-ink-s))`;
  });
}

/** A mix as bands from left to right, in display order. */
export function bands(freq: readonly number[], order: readonly number[], colours: readonly string[]): string {
  let at = 0;
  const stops = order.map((a) => {
    const from = at;
    at += (freq[a] ?? 0) * 100;
    return `${colours[a]} ${from.toFixed(1)}% ${at.toFixed(1)}%`;
  });
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

/** `AhKd` with suit symbols, each suit coloured. */
export function CardsText({ cards }: { cards: string }) {
  if (cards.length !== 4 || !SUITS[cards[1]] || !SUITS[cards[3]]) return <>{cards}</>;
  return (
    <span className={styles.cardsText}>
      <span data-suit={cards[1]}>
        {cards[0]}
        {SUITS[cards[1]]}
      </span>
      <span data-suit={cards[3]}>
        {cards[2]}
        {SUITS[cards[3]]}
      </span>
    </span>
  );
}

export function RangeGrid({
  view,
  strategy,
  highlight = null,
}: {
  view: RangeView;
  strategy: boolean;
  /** A class picked elsewhere (an example hand): the rest dims. */
  highlight?: number | null;
}) {
  const { t, locale } = useTrainerHost();
  const [only, setOnly] = useState<number | null>(null);
  const [hover, setHover] = useState<ZoomAnchor | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const most = Math.max(1e-9, ...view.cells.map((cell) => cell.combos));
  const tones = view.options.map(toneOf);
  const order = displayOrder(view.options);
  const colours = optionColours(view.options);
  const total = view.cells.reduce((sum, cell) => sum + cell.combos, 0);
  const picked = strategy && only !== null && only < tones.length ? only : null;
  const combos = picked === null ? total : view.cells.reduce((sum, cell) => sum + cell.combos * (cell.freq[picked] ?? 0), 0);
  const pct = (value: number) => `${Math.round(value * 100).toLocaleString(locale)}%`;

  const onOver = (event: MouseEvent<HTMLDivElement>) => {
    const el = (event.target as HTMLElement).closest<HTMLElement>("[data-cell]");
    const wrap = wrapRef.current;
    if (!el || !wrap) return;
    const cell = Number(el.dataset.cell);
    if (hover?.cell === cell) return;
    setHover(zoomAnchor(cell, el, wrap));
  };

  return (
    <div className={styles.range}>
      <p className={styles.rangeSummary}>
        {t.rangeCombos(combos, combos / ALL_COMBOS)}
        {picked !== null ? (
          <span className={styles.muted}>
            {" "}
            · {t.words.option(view.options[picked].action, view.options[picked].sizeBb, view.options[picked].allIn, view.options[picked].sizePot)}
          </span>
        ) : null}
      </p>
      <div ref={wrapRef} className={styles.rangeGridWrap}>
        <div className={styles.rangeGrid} role="img" aria-label={t.rangeHeading} onMouseOver={onOver} onMouseLeave={() => setHover(null)}>
          {view.cells.map((cell, k) => {
            const weight = cell.combos / most;
            let background = "var(--surface-inset)";
            let lit = cell.combos > 0;
            if (cell.combos > 0) {
              if (picked !== null) {
                const share = (cell.freq[picked] ?? 0) * 100;
                lit = share > 0.5;
                background = `linear-gradient(to right, ${colours[picked]} ${share.toFixed(1)}%, var(--surface-inset) ${share.toFixed(1)}%)`;
              } else if (strategy && cell.freq.length === tones.length) {
                background = bands(cell.freq, order, colours);
              } else {
                background = "var(--accent)";
              }
            }
            const style = { background, opacity: lit ? 0.3 + 0.7 * weight : cell.combos > 0 ? 0.35 : 1 } as CSSProperties;
            return (
              <span
                key={cell.name}
                className={styles.rangeCell}
                style={style}
                data-cell={k}
                data-hero={cell.name === view.heroClass || undefined}
                data-dim={(highlight !== null && highlight !== k) || undefined}
                data-lit={highlight === k || undefined}
              >
                {cell.name}
              </span>
            );
          })}
        </div>
        {hover ? <Zoom view={view} hover={hover} strategy={strategy} order={order} colours={colours} /> : null}
      </div>
      {strategy ? (
        <div className={styles.rangeLegend} role="group" aria-label={t.rangeShow}>
          {order.map((a) => (
            <button
              key={a}
              type="button"
              className={styles.rangeOption}
              data-action={tones[a]}
              aria-pressed={picked === a}
              onClick={() => setOnly((current) => (current === a ? null : a))}
            >
              <span className={styles.rangeSwatch} style={{ background: colours[a] }} aria-hidden="true" />
              {t.words.option(view.options[a].action, view.options[a].sizeBb, view.options[a].allIn, view.options[a].sizePot)}
              <span className={styles.muted}>{pct(view.shares[a] ?? 0)}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function comboOrder(a: RangeCombo, b: RangeCombo): number {
  return SUIT_ORDER.indexOf(a.cards[1]) - SUIT_ORDER.indexOf(b.cards[1]) || SUIT_ORDER.indexOf(a.cards[3]) - SUIT_ORDER.indexOf(b.cards[3]);
}

/** The hovered class, zoomed, and its combos under it (GTO Wizard's hover, `@rail/ui` ComboZoom). */
function Zoom({
  view,
  hover,
  strategy,
  order,
  colours,
}: {
  view: RangeView;
  hover: ZoomAnchor;
  strategy: boolean;
  order: number[];
  colours: string[];
}) {
  const { t, locale } = useTrainerHost();
  const cell = view.cells[hover.cell];
  // A class the range never reaches has nothing to zoom.
  if (!cell || !(cell.combos > 0)) return null;
  const showMix = strategy && cell.freq.length === view.options.length;
  const actions: ZoomAction[] = view.options.map((o, a) => ({
    label: t.zoom.actions[o.allIn ? "allin" : o.action] ?? o.action,
    size:
      o.sizeBb !== null && o.sizeBb !== undefined
        ? `${o.sizePot ? `${Math.round(o.sizePot * 100)}% ` : ""}(${o.sizeBb.toLocaleString(locale, { maximumFractionDigits: 1 })})`
        : null,
    colour: colours[a],
  }));
  const combos = showMix && view.combos ? view.combos.filter((c) => c.cell === hover.cell && c.weight > 0).sort(comboOrder) : [];
  return (
    <GridZoom
      anchor={hover}
      name={cell.name}
      count={combos.length > 0 ? combos.length : Math.round(cell.combos * 10) / 10}
      freq={showMix ? cell.freq : null}
      combos={combos.map((c) => ({ cards: c.cards, freq: c.freq, you: c.cards === view.heroCombo }))}
      actions={actions}
      order={order}
      words={{ combos: t.zoom.combos, you: t.zoom.you }}
      locale={locale}
    />
  );
}
