/**
 * What a hand does, combo by combo, as GTO Wizard shows it on hover: the
 * class in a box filled with its strategy as bands (the bets on the left, the
 * passive play on the right) and a row per action, `Bet 75% (4.1) … 83.8`;
 * under it a card per combo, each with its own bands and rows.
 *
 * One look for every 13×13 grid that has a strategy (the trainer, the
 * solver, the nodelock editor, the Analysis charts and studies), in two
 * forms:
 *
 * - {@link GridZoom}: the hover. The class box sits over the hovered cell,
 *   the combo cards under it (above it when there is no room), both inside
 *   the grid's wrapper, which is `position: relative` (`zoomAnchor` measures
 *   the cell against it). It never takes the pointer.
 * - {@link ComboCards}: the same cards in a panel, with the EV of every
 *   action when the caller has it, combos the board takes out as hatched
 *   cards and an optional click (the nodelock editor paints a combo).
 *
 * The words come from the caller (`ZoomWords`); colours are a class that
 * paints a background (`className`) or a CSS colour (`colour`) per action.
 */

import type { CSSProperties, ReactNode } from "react";
import styles from "./ComboZoom.module.css";

export interface ZoomAction {
  /** `Bet`, `Check`, `All-in`. */
  label: string;
  /** `75% (4.1)`, `(2.5)`: after the label, smaller. */
  size?: string | null;
  /** Paints the band (a class with a `background`), or `colour` does. */
  className?: string;
  colour?: string;
  /** No hand takes it: left out of the rows. */
  hidden?: boolean;
}

export interface ZoomCombo {
  /** `AhKd`. */
  cards: string;
  freq: readonly number[];
  /** Per action, bb: an EV column in the panel's cards. */
  ev?: readonly number[] | null;
  /** How much of the combo reaches the decision, 0..1: the bands' height. */
  reach?: number;
  /** The hero's combo: ringed and tagged. */
  you?: boolean;
  /** The combo is not in play here: the reason, on a hatched card. */
  off?: string | null;
  /** A change of its EV against a baseline (the nodelock's Compare with GTO), bb: a signed pill under the rows. */
  delta?: { value: number; text: string } | null;
  /** After the cards (the nodelock editor's lock). */
  mark?: ReactNode;
  /** Ringed as picked. */
  picked?: boolean;
  /** The card's accessible name, when it is a button. */
  label?: string;
}

export interface ZoomWords {
  /** `3 combos`. */
  combos: (n: number) => string;
  /** The hero's tag. */
  you: string;
  /** The EV column's head. */
  ev?: string;
}

export interface ZoomAnchor {
  /** The hovered cell, 0..168 (grid order). */
  cell: number;
  /** The cell against the wrapper, px. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The wrapper's size, px. */
  gw: number;
  gh: number;
}

/** The hovered cell measured against the grid's wrapper (the zoom's positioned ancestor). */
export function zoomAnchor(cell: number, el: Element, wrap: Element): ZoomAnchor {
  const c = el.getBoundingClientRect();
  const g = wrap.getBoundingClientRect();
  return { cell, x: c.left - g.left, y: c.top - g.top, w: c.width, h: c.height, gw: g.width, gh: g.height };
}

/** Below this an action is nothing: left out of the rows of a class or combo that never takes it. */
const NONE = 0.0005;

/** A frequency as GTO Wizard writes it: `83.8`, `1`, `0.4`. */
export function freqText(value: number, locale?: string): string {
  const x = Math.round(value * 1000) / 10;
  return x.toLocaleString(locale, { maximumFractionDigits: x % 1 === 0 ? 0 : 1 });
}

/** Green above zero, red below, at the 0.01 shown. */
function toneOf(value: number): string {
  const x = Math.round(value * 100);
  return x > 0 ? styles.evPos : x < 0 ? styles.evNeg : "";
}

function signedText(value: number, locale?: string): string {
  const x = Math.round(value * 100) / 100;
  const text = Math.abs(x).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return x > 0 ? `+${text}` : x < 0 ? `−${text}` : text;
}

/**
 * The display order: all-in, the bets and raises biggest first, then call,
 * check, fold. `kind` and `size` (bb or a share of the pot, any one scale)
 * per action, in the caller's order.
 */
export function aggressiveFirst(actions: ReadonlyArray<{ kind: string; size?: number | null }>): number[] {
  const rank = (kind: string) => (kind === "allin" ? 0 : kind === "bet" || kind === "raise" ? 1 : kind === "call" ? 2 : kind === "check" ? 3 : 4);
  return actions
    .map((_, a) => a)
    .sort((a, b) => rank(actions[a].kind) - rank(actions[b].kind) || (actions[b].size ?? 0) - (actions[a].size ?? 0));
}

/** The mix as bands, left to right in `order`, as tall as `reach` from the bottom. */
function Bands({ freq, actions, order, reach = 1 }: { freq: readonly number[]; actions: readonly ZoomAction[]; order: readonly number[]; reach?: number }) {
  return (
    <span className={styles.bands} style={{ blockSize: `${Math.max(0, Math.min(1, reach)) * 100}%` }} aria-hidden="true">
      {order.map((a) =>
        (freq[a] ?? 0) > 0 ? (
          <span key={a} className={actions[a]?.className} style={{ inlineSize: `${freq[a] * 100}%`, background: actions[a]?.colour }} />
        ) : null,
      )}
    </span>
  );
}

function Rows({
  freq,
  ev,
  actions,
  order,
  locale,
}: {
  freq: readonly number[];
  ev?: readonly number[] | null;
  actions: readonly ZoomAction[];
  order: readonly number[];
  locale?: string;
}) {
  return (
    <span className={styles.rows}>
      {order.map((a) => {
        const action = actions[a];
        if (!action || action.hidden) return null;
        const none = (freq[a] ?? 0) < NONE;
        return (
          <span key={a} className={`${styles.row} ${none ? styles.rowNone : ""}`}>
            <span className={styles.rowLabel}>{action.label}</span>
            {action.size ? <small>{action.size}</small> : null}
            <span className={styles.value}>{freqText(freq[a] ?? 0, locale)}</span>
            {ev ? (
              <span className={`${styles.ev} ${toneOf(ev[a] ?? 0)}`}>
                {none ? "" : signedText(ev[a] ?? 0, locale)}
              </span>
            ) : null}
          </span>
        );
      })}
    </span>
  );
}

const SUITS: Record<string, string> = { s: "♠", h: "♥", d: "♦", c: "♣" };

/** `A♠K♦` on a white chip, each suit in its colour. */
export function CardChip({ cards }: { cards: string }) {
  const pair = [cards.slice(0, 2), cards.slice(2, 4)];
  return (
    <span className={styles.chip}>
      {pair.map((card, i) => (
        <span key={i} data-suit={card[1]}>
          {card[0]}
          {SUITS[card[1]] ?? card[1]}
        </span>
      ))}
    </span>
  );
}

interface CardProps {
  combo: ZoomCombo;
  actions: readonly ZoomAction[];
  order: readonly number[];
  words: ZoomWords;
  locale?: string;
  /** Show the EV column (the panel). */
  withEv?: boolean;
  onClick?: () => void;
  style?: CSSProperties;
}

/** One combo: its cards, the head's `%` (and `EV`), its bands and rows. */
export function ComboCard({ combo, actions, order, words, locale, withEv = false, onClick, style }: CardProps) {
  const classes = [styles.card, combo.off ? styles.cardOff : "", combo.you ? styles.cardYou : "", combo.picked ? styles.cardPicked : "", onClick ? styles.cardButton : ""]
    .filter(Boolean)
    .join(" ");
  const body = (
    <>
      {combo.off ? null : <Bands freq={combo.freq} actions={actions} order={order} reach={combo.reach ?? 1} />}
      <span className={styles.head}>
        <CardChip cards={combo.cards} />
        {combo.you ? <span className={styles.you}>{words.you}</span> : null}
        {combo.mark ?? null}
        {combo.off ? null : (
          <span className={styles.headUnits}>
            <span>%</span>
            {withEv && combo.ev ? <span className={styles.ev}>{words.ev ?? "EV"}</span> : null}
          </span>
        )}
      </span>
      {combo.off ? (
        <span className={styles.offText}>{combo.off}</span>
      ) : (
        <Rows freq={combo.freq} ev={withEv ? combo.ev : null} actions={actions} order={order} locale={locale} />
      )}
      {combo.off || !combo.delta ? null : (
        <span className={`${styles.delta} ${toneOf(combo.delta.value)}`}>{combo.delta.text}</span>
      )}
    </>
  );
  if (onClick) {
    return (
      <button type="button" className={classes} style={style} aria-label={combo.label} aria-pressed={combo.picked} onClick={onClick}>
        {body}
      </button>
    );
  }
  return (
    <span className={classes} style={style} aria-label={combo.label}>
      {body}
    </span>
  );
}

/** The combos as cards in a panel: as many across as fit. */
export function ComboCards({
  combos,
  actions,
  order,
  words,
  locale,
  withEv = false,
  onPick,
  label,
}: {
  combos: readonly ZoomCombo[];
  actions: readonly ZoomAction[];
  order: readonly number[];
  words: ZoomWords;
  locale?: string;
  withEv?: boolean;
  onPick?: (combo: ZoomCombo, index: number) => void;
  label?: string;
}) {
  return (
    <ul className={styles.list} aria-label={label}>
      {combos.map((combo, i) => (
        <li key={combo.cards}>
          <ComboCard
            combo={combo}
            actions={actions}
            order={order}
            words={words}
            locale={locale}
            withEv={withEv}
            onClick={onPick ? () => onPick(combo, i) : undefined}
          />
        </li>
      ))}
    </ul>
  );
}

/** The class as the zoom's top box: name, combos, bands and rows. */
export function ClassCard({
  name,
  count,
  freq,
  reach = 1,
  actions,
  order,
  words,
  locale,
  style,
}: {
  name: string;
  count: number;
  freq: readonly number[] | null;
  reach?: number;
  actions: readonly ZoomAction[];
  order: readonly number[];
  words: ZoomWords;
  locale?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={`${styles.box} ${styles.classBox}`} style={style} aria-hidden="true">
      {freq ? <Bands freq={freq} actions={actions} order={order} reach={reach} /> : null}
      <span className={styles.name}>
        {name}
        <small>{words.combos(count)}</small>
      </span>
      {freq ? <Rows freq={freq} actions={actions} order={order} locale={locale} /> : null}
    </div>
  );
}

const LINE = 15;

/**
 * The hover: the class box over the hovered cell (four cells wide, three
 * tall, inside the grid) and its combos under it. Rendered inside the grid's
 * positioned wrapper; `combos` empty (preflop, where every combo plays the
 * class's mix) shows the class box alone.
 */
export function GridZoom({
  anchor,
  name,
  count,
  freq,
  reach = 1,
  combos,
  actions,
  order,
  words,
  locale,
}: {
  anchor: ZoomAnchor;
  name: string;
  /** The combos of the class here (weighted, or counted). */
  count: number;
  /** The class's mix, or null (no strategy: the name and count only). */
  freq: readonly number[] | null;
  reach?: number;
  combos: readonly ZoomCombo[];
  actions: readonly ZoomAction[];
  order: readonly number[];
  words: ZoomWords;
  locale?: string;
}) {
  const rows = freq ? order.filter((a) => actions[a] && !actions[a].hidden).length : 0;
  const pitch = anchor.w + 2;

  const W = Math.max(4 * pitch - 2, 150);
  const H = Math.max(3 * pitch - 2, 30 + rows * LINE + 8);
  const x = Math.max(0, Math.min(anchor.x, anchor.gw - W));
  const y = anchor.y + H > anchor.gh ? Math.max(0, anchor.y + anchor.h - H) : anchor.y;

  const shown = combos.filter((c) => !c.off);
  const cols = shown.length > 4 ? 3 : Math.max(1, Math.min(2, shown.length));
  const cw = cols === 3 ? Math.max(130, (anchor.gw - 8) / 3) : Math.min(180, Math.max(140, (anchor.gw - 6) / 2));
  const ch = 26 + rows * (LINE - 1) + 6;
  const lines = Math.ceil(shown.length / cols);
  const W2 = cols * cw + (cols - 1) * 2 + 4;
  const H2 = lines * ch + (lines - 1) * 2 + 4;
  const x2 = Math.max(0, Math.min(x, anchor.gw - W2));
  let y2 = y + H + 4;
  if (y2 + H2 > anchor.gh + 60 && y - 4 - H2 >= -60) y2 = y - 4 - H2;

  return (
    <>
      <ClassCard
        name={name}
        count={count}
        freq={freq}
        reach={reach}
        actions={actions}
        order={order}
        words={words}
        locale={locale}
        style={{ left: x, top: y, inlineSize: W, blockSize: H }}
      />
      {shown.length > 0 && freq ? (
        <div
          className={`${styles.box} ${styles.combosBox}`}
          style={{ left: x2, top: y2, inlineSize: W2, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
          aria-hidden="true"
        >
          {shown.map((combo) => (
            <ComboCard key={combo.cards} combo={combo} actions={actions} order={order} words={words} locale={locale} style={{ blockSize: ch }} />
          ))}
        </div>
      ) : null}
    </>
  );
}
