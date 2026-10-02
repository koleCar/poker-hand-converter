/**
 * The widgets that take cards: the board-texture explorer, the hand-vs-range
 * equity demo, range vs range (range and nut advantage), and the combo
 * counter (blockers).
 *
 * The texture explorer calls `boardTexture()` from `lib/analysis` — the very
 * function that describes the boards in the reader's own hands — so what it
 * says here and what the Analysis sheet says about a hand never disagree.
 * Equities are seeded samples (`lib/equity`, `lib/learn/math`): the same
 * question gives the same number on every render.
 */

"use client";

import { useMemo, useState } from "react";
import { boardTexture, toIndices } from "../../lib/analysis/texture";
import { equityVsRange } from "../../lib/equity/range";
import { useDict } from "../../lib/i18n/client";
import { countCombos, nutShare, rangeVsRange, realisedEquity, requiredEquity } from "../../lib/learn/math";
import {
  BOARD_PRESETS,
  COMBO_PRESETS,
  MATCHUP_PRESETS,
  RANGE_PRESETS,
  presetRange,
  type RangeId,
} from "../../lib/learn/presets";
import { CardPicker, CardPresets } from "./CardPicker";
import { ShareBar, Slider, Stat, Stats, useFormats } from "./controls";
import styles from "./learn.module.css";
import "../../styles/stats.css";

const WIDGET_PREFLOP_TRIALS = 100_000;

/** A board is a street when it has 0, 3, 4 or 5 cards. */
const isStreet = (board: readonly string[]) => board.length === 0 || board.length >= 3;

/* --------------------------------------------------------------- texture - */

export function BoardExplorer({ board: board0, focus }: { board: readonly string[]; focus: "texture" | "dynamism" }) {
  const en = useDict();
  const t = en.learn.widgets;
  const f = useFormats();
  const [board, setBoard] = useState<string[]>([...board0]);
  const texture = useMemo(() => (board.length >= 3 ? boardTexture(toIndices(board)) : null), [board]);

  const randomFlop = () => {
    const deck: string[] = [];
    for (const rank of "AKQJT98765432") for (const suit of "shdc") deck.push(`${rank}${suit}`);
    const out: string[] = [];
    while (out.length < 3) {
      const card = deck[Math.floor(Math.random() * deck.length)];
      if (!out.includes(card)) out.push(card);
    }
    setBoard(out);
  };

  // The words the analysis uses for a board, one tag each.
  const tags: string[] = texture
    ? [
        texture.trips ? t.texture.trips : texture.paired ? t.texture.paired : t.texture.unpaired,
        t.texture.suits[texture.suits],
        `${t.texture.connectedness[texture.connectedness]} · ${t.texture.straightCombos}: ${texture.straightCombos}`,
        t.texture.highCard[texture.highCard],
        `${t.texture.flushPossible}: ${texture.flushPossible ? t.texture.yes : t.texture.no}`,
        `${t.texture.straightPossible}: ${texture.straightPossible ? t.texture.yes : t.texture.no}`,
      ]
    : [];

  return (
    <div className={styles.calc}>
      <div className={styles.controls}>
        <CardPresets presets={BOARD_PRESETS} current={board} onPick={setBoard} />
        <div>
          <button type="button" className="btn btn--sm" onClick={randomFlop}>
            {t.cards.random}
          </button>
        </div>
        <CardPicker label={t.cards.pickBoard} selected={board} max={5} onChange={setBoard} />
      </div>
      {texture ? (
        <div className={styles.results}>
          {texture.dynamism ? (
            <Stats>
              <Stat
                lead={focus === "dynamism"}
                label={t.texture.volatility}
                value={`${f.pct(texture.volatility ?? 0)} · ${t.texture.dynamism[texture.dynamism]}`}
                note={t.texture.thresholds}
              />
            </Stats>
          ) : (
            <p className={styles.hint}>{t.texture.river}</p>
          )}
          {texture.volatility !== null ? <ShareBar value={texture.volatility} /> : null}
          <ul className={styles.tags} aria-label={en.analysis.sheet.facts.board}>
            {tags.map((tag) => (
              <li key={tag}>{tag}</li>
            ))}
          </ul>
          <p className={styles.hint}>{t.texture.volatilityHint}</p>
        </div>
      ) : (
        <p className={styles.hint}>{t.texture.needCards}</p>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- equity - */

export function EquityDemo({
  hand: hand0,
  preset,
  focus,
  realisation: realisation0,
}: {
  hand: readonly string[];
  preset: RangeId;
  focus: "realisation" | "range";
  realisation: number;
}) {
  const t = useDict().learn.widgets;
  const f = useFormats();
  const [hand, setHand] = useState<string[]>([...hand0]);
  const [board, setBoard] = useState<string[]>([]);
  const [rangeId, setRangeId] = useState<RangeId>(preset);
  const [realisation, setRealisation] = useState(realisation0);
  const [price, setPrice] = useState(requiredEquity(4, 1.5));

  const result = useMemo(() => {
    if (hand.length !== 2 || !isStreet(board)) return null;
    try {
      // Preflop has the most runouts to sample, so it gets the most samples:
      // the page quotes these equities to a tenth of a percent.
      return equityVsRange({ hero: hand, range: presetRange(rangeId), board, trials: board.length === 0 ? WIDGET_PREFLOP_TRIALS : 20_000 });
    } catch {
      return null;
    }
  }, [hand, board, rangeId]);

  const realised = result ? realisedEquity(result.equity, realisation) : 0;
  return (
    <div className={styles.calc}>
      <div className={styles.controls}>
        <label className="field">
          <span className="field__label">{t.equity.range}</span>
          <select value={rangeId} onChange={(event) => setRangeId(event.target.value as RangeId)}>
            {RANGE_PRESETS.map((id) => (
              <option key={id} value={id}>
                {t.equity.ranges[id] ?? id}
              </option>
            ))}
          </select>
        </label>
        <CardPicker label={t.cards.pickHand} selected={hand} max={2} blocked={board} onChange={setHand} />
        <CardPicker label={t.cards.pickBoard} selected={board} max={5} blocked={hand} onChange={setBoard} />
        {focus === "realisation" ? (
          <>
            <Slider label={t.equity.realisation} value={realisation} min={0.4} max={1.3} step={0.05} onChange={setRealisation} format={f.pct} />
            <Slider label={t.equity.priceLabel} value={price} min={0.05} max={0.6} step={0.005} onChange={setPrice} format={f.pct} />
          </>
        ) : null}
      </div>
      {hand.length !== 2 ? (
        <p className={styles.hint}>{t.equity.needHand}</p>
      ) : !isStreet(board) ? (
        <p className={styles.hint}>{t.cards.pickBoard}</p>
      ) : result && result.combos === 0 ? (
        <p className={styles.hint}>{t.equity.emptyRange}</p>
      ) : result ? (
        <div className={styles.results}>
          <Stats>
            <Stat lead={focus === "range"} label={t.equity.raw} value={f.pct(result.equity)} note={t.equity.combos(result.combos, f.num(result.combos, 0))} />
            {focus === "realisation" ? (
              <Stat
                lead
                label={t.equity.realised}
                value={f.pct(realised)}
                tone={realised >= price ? "good" : "bad"}
                note={`${t.equity.priceLabel}: ${f.pct(price)}`}
              />
            ) : null}
          </Stats>
          <ShareBar value={focus === "realisation" ? realised : result.equity} marker={focus === "realisation" ? price : undefined} tone={focus === "realisation" ? (realised >= price ? "good" : "bad") : "neutral"} />
          <p className={styles.hint}>
            {t.illustrative} {result.method === "monte-carlo" ? t.equity.sampled : null}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------- range vs range - */

export function RangeVsRange({ preset, board: board0, focus }: { preset: string; board: readonly string[]; focus: "range" | "nuts" }) {
  const t = useDict().learn.widgets;
  const f = useFormats();
  const [matchupId, setMatchupId] = useState(preset);
  const [board, setBoard] = useState<string[]>([...board0]);
  const matchup = MATCHUP_PRESETS.find((m) => m.id === matchupId) ?? MATCHUP_PRESETS[0];

  const result = useMemo(() => {
    if (!isStreet(board)) return null;
    const a = presetRange(matchup.a);
    const b = presetRange(matchup.b);
    const equity = rangeVsRange(a, b, board, 20_000).equity;
    const nuts = board.length >= 3 ? { a: nutShare(a, board), b: nutShare(b, board) } : null;
    return { equity, nuts };
  }, [matchup, board]);

  return (
    <div className={styles.calc}>
      <div className={styles.controls}>
        <label className="field">
          <span className="field__label">{t.rvr.matchup}</span>
          <select value={matchup.id} onChange={(event) => setMatchupId(event.target.value)}>
            {MATCHUP_PRESETS.map((m) => (
              <option key={m.id} value={m.id}>
                {t.rvr.matchups[m.id] ?? m.id}
              </option>
            ))}
          </select>
        </label>
        <CardPresets presets={BOARD_PRESETS} current={board} onPick={setBoard} />
        <CardPicker label={t.cards.pickBoard} selected={board} max={5} onChange={setBoard} />
      </div>
      {result ? (
        <div className={styles.results}>
          <p className={styles.subhead}>{t.rvr.equity}</p>
          <Stats>
            <Stat lead={focus === "range"} label={`${t.rvr.raiser} · ${t.equity.ranges[matchup.a] ?? matchup.a}`} value={f.pct(result.equity)} />
            <Stat label={`${t.rvr.caller} · ${t.equity.ranges[matchup.b] ?? matchup.b}`} value={f.pct(1 - result.equity)} />
          </Stats>
          <ShareBar value={result.equity} marker={0.5} />
          {result.nuts ? (
            <>
              <p className={styles.subhead}>{t.rvr.nuts}</p>
              <Stats>
                <Stat lead={focus === "nuts"} label={t.rvr.raiser} value={f.pct(result.nuts.a)} />
                <Stat lead={focus === "nuts"} label={t.rvr.caller} value={f.pct(result.nuts.b)} />
              </Stats>
            </>
          ) : (
            <p className={styles.hint}>{t.rvr.needFlop}</p>
          )}
          <p className={styles.hint}>{t.illustrative}</p>
        </div>
      ) : (
        <p className={styles.hint}>{t.rvr.needFlop}</p>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- combos - */

export function ComboCounter({ hand: hand0, preset }: { hand: readonly string[]; preset: string }) {
  const t = useDict().learn.widgets;
  const f = useFormats();
  const [hand, setHand] = useState<string[]>([...hand0]);
  const [board, setBoard] = useState<string[]>([]);
  const [presetId, setPresetId] = useState(preset);
  const classes = (COMBO_PRESETS.find((p) => p.id === presetId) ?? COMBO_PRESETS[0]).classes;
  const rows = countCombos(classes, [...hand, ...board]);
  const total = rows.reduce((sum, row) => sum + row.total, 0);
  const left = rows.reduce((sum, row) => sum + row.left, 0);

  return (
    <div className={styles.calc}>
      <div className={styles.controls}>
        <label className="field">
          <span className="field__label">{t.combos.preset}</span>
          <select value={presetId} onChange={(event) => setPresetId(event.target.value)}>
            {COMBO_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {t.combos.presets[p.id] ?? p.id}
              </option>
            ))}
          </select>
        </label>
        <CardPicker label={t.cards.pickHand} selected={hand} max={2} blocked={board} onChange={setHand} />
        <CardPicker label={t.cards.pickBoard} selected={board} max={5} blocked={hand} onChange={setBoard} />
      </div>
      <div className={styles.results} aria-live="polite">
        <div className="stats-table-wrap">
          <table className="stats-table">
            <thead>
              <tr>
                <th scope="col">{t.combos.class}</th>
                <th scope="col" className="num">
                  {t.combos.total}
                </th>
                <th scope="col" className="num">
                  {t.combos.left}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.name}>
                  <th scope="row">{row.name}</th>
                  <td className="num">{row.total}</td>
                  <td className={`num ${row.left < row.total ? styles.toneGood : ""}`}>{row.left}</td>
                </tr>
              ))}
              <tr>
                <th scope="row">{t.combos.sum}</th>
                <td className="num">{total}</td>
                <td className="num">{left}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className={styles.hint}>{t.combos.removed(f.pct(total > 0 ? (total - left) / total : 0))}</p>
      </div>
    </div>
  );
}
