/**
 * Pool (docs/ANALYTICS.md Step 10; boards AN-Main "Pool" and AN-Pool): how
 * the player's opponents play, by Rail's player types.
 *
 * - Four figures: regs : fish by their hands with the player, the regs' win
 *   rate ± its standard error, the player's win rate with a fish in the pot
 *   and with regs only.
 * - A row per catalogue rate: You, Regs, Fish, the target (the player's
 *   own, approximate for the pool) and what it means - an exploit sentence
 *   where a type's gap is clear on its own opportunities (`pool.ts`), else a
 *   quiet word. "Exploits only" keeps the rows with a sentence.
 *
 * Pro (`lock`): the whole tab is held back behind the surface's lock.
 */
import type { ReactNode } from "react";

import { countIn } from "../hands/format";
import { useUiStrings, type AnalyticsStrings } from "../i18n";
import { RailLoader } from "../loader/RailLoader";
import type { Catalogue, CatalogueStat, CheckerResult } from "../model/checker";
import { fixedIn } from "../stats/format";
import { TONE, hoverOf, rateIn } from "./AllStats";
import styles from "./Analytics.module.css";
import { statName } from "./findings";
import type { PoolSums, PoolYou } from "./model";
import {
  poolEmpty,
  poolFigures,
  poolRows,
  shownPoolRows,
  youRates,
  type PoolCell,
  type PoolExploit,
  type PoolRow,
  type PoolShow,
} from "./poolView";
import { Dismissible } from "../notice/Dismissible";

/** An exploit's sentence: the stat's own for its direction, else its words. */
export function exploitText(stat: CatalogueStat, exploit: PoolExploit, words: AnalyticsStrings): string {
  const p = words.screen.pool;
  const who = exploit.types.length > 1 ? p.who.both : (p.who[exploit.types[0]] ?? exploit.types[0]);
  const own = p.exploit[stat.id];
  return own ? own[exploit.direction](who) : p.fallback(who, stat.words[exploit.direction][words.lang]);
}

/** What a row says without an exploit. */
export function quietMeaning(row: PoolRow, words: AnalyticsStrings): string {
  const p = words.screen.pool;
  if (row.target === null) return p.noTarget;
  if (row.reg.opp + row.fish.opp === 0) return "—";
  if (!row.targetSure || row.reg.tone === "few" || row.fish.tone === "few") return p.notSure;
  return p.close;
}

export function PoolControls({ show, onShow }: { show: PoolShow; onShow: (show: PoolShow) => void }) {
  const p = useUiStrings().analytics.screen.pool;
  const chip = (on: boolean) => `chip-btn${on ? " is-active" : ""}`;
  return (
    <div className={styles.controls}>
      <div className={styles.seg} role="group" aria-label={p.showLabel}>
        {(["all", "exploits"] as const).map((value) => (
          <button key={value} type="button" className={chip(show === value)} aria-pressed={show === value} onClick={() => onShow(value)}>
            {p.show[value]}
          </button>
        ))}
      </div>
    </div>
  );
}

export interface PoolProps {
  catalogue: Catalogue;
  /** The player's checker result (their numbers and targets); null while it loads. */
  result: CheckerResult | null;
  sums: PoolSums | null;
  /** The player's results with a fish in the pot, and with regs and no fish; null while they load. */
  you: PoolYou | null;
  show: PoolShow;
  /** The surface's Pro lock: the tab is held back. */
  lock?: ReactNode;
  loading?: boolean;
  error?: string | null;
  /** The browser counting the pool: hands left. */
  counting?: number | null;
  /** All stats (the empty state's way on). */
  onAllStats?: () => void;
  /**
   * The web with the opponents' statistics switched off (nobody can be
   * typed): the link to the setting, shown with one line in place of the
   * empty state (Step 12).
   */
  off?: ReactNode;
}

export function Pool({
  catalogue,
  result,
  sums,
  you: youSums,
  show,
  lock,
  loading = false,
  error = null,
  counting = null,
  onAllStats,
  off,
}: PoolProps) {
  const ui = useUiStrings();
  const words = ui.analytics;
  const p = words.screen.pool;
  const locale = ui.intlLocale;
  if (lock !== undefined && lock !== null) {
    return (
      <section className={styles.pool} aria-label={words.screen.tabs.pool}>
        {lock}
      </section>
    );
  }
  if (sums === null) {
    if (error !== null) return <Dismissible className={styles.quiet} role="alert">{p.error(error)}</Dismissible>;
    if (loading) return <RailLoader size="small" label={words.screen.stats.loading} showLabel centered />;
    return null;
  }
  const status =
    counting !== null && counting > 0 ? (
      <p className={styles.quiet} role="status">
        {p.counting(countIn(locale, counting))}
      </p>
    ) : sums.pending > 0 && counting === null ? (
      <p className={styles.quiet} role="status">
        {p.pending(countIn(locale, sums.pending))}
      </p>
    ) : null;
  if (poolEmpty(sums)) {
    // Still counting: the count's line alone (the pool is not empty, it is not counted yet).
    return (
      <section className={styles.pool} aria-label={words.screen.tabs.pool}>
        {status ?? (
          <p className={styles.quiet}>
            {off !== undefined && off !== null ? (
              <>
                {p.off} {off}
              </>
            ) : (
              <>
                {p.empty}{" "}
                {onAllStats ? (
                  <button type="button" className={styles.link} onClick={onAllStats}>
                    {p.allStats}
                  </button>
                ) : null}
              </>
            )}
          </p>
        )}
      </section>
    );
  }
  const figures = poolFigures(sums);
  const you = youRates(youSums);
  const rows = shownPoolRows(poolRows(catalogue, result, sums), show);
  const one = fixedIn(locale, 1);
  const signed = (value: number | null) => (value === null ? "—" : `${value > 0 ? "+" : value < 0 ? "−" : ""}${one(Math.abs(value))}`);
  const sign = (value: number | null) => (value === null || Math.abs(value) < 0.05 ? "" : value > 0 ? styles.up : styles.down);

  return (
    <section className={styles.pool} aria-label={words.screen.tabs.pool}>
      {status}
      {error !== null ? (
        <Dismissible className={styles.quiet} role="alert">
          {p.error(error)}
        </Dismissible>
      ) : null}
      <dl className={styles.poolFigs} aria-label={p.figures.label}>
        <div className={styles.poolFig}>
          <dt>{p.figures.ratio}</dt>
          <dd>{figures.ratio === null ? "—" : p.figures.ratioValue(one(figures.ratio))}</dd>
          <dd className={styles.poolSub}>{p.figures.ratioSub(countIn(locale, figures.reg.hands), countIn(locale, figures.fish.hands))}</dd>
        </div>
        <div className={styles.poolFig}>
          <dt>{p.figures.regRate}</dt>
          <dd className={sign(figures.regRate)}>{signed(figures.regRate)}</dd>
          <dd className={styles.poolSub}>{p.figures.regRateSub(figures.regSe === null ? null : one(figures.regSe))}</dd>
        </div>
        <div className={styles.poolFig}>
          <dt>{p.figures.youFish}</dt>
          <dd className={sign(you.fish?.bb100 ?? null)}>{signed(you.fish?.bb100 ?? null)}</dd>
          <dd className={styles.poolSub}>{p.figures.youSub(countIn(locale, you.fish?.hands ?? 0), you.fish?.hands ?? 0)}</dd>
        </div>
        <div className={styles.poolFig}>
          <dt>{p.figures.youRegs}</dt>
          <dd className={sign(you.regsOnly?.bb100 ?? null)}>{signed(you.regsOnly?.bb100 ?? null)}</dd>
          <dd className={styles.poolSub}>{p.figures.youSub(countIn(locale, you.regsOnly?.hands ?? 0), you.regsOnly?.hands ?? 0)}</dd>
        </div>
      </dl>
      {rows.length === 0 ? (
        <p className={styles.quiet}>{p.none}</p>
      ) : (
        <div className={styles.poolTable}>
          <div className={styles.poolHead} aria-hidden="true">
            <span>{p.head.stat}</span>
            <span className={styles.end}>{p.head.you}</span>
            <span className={styles.end}>{p.head.reg}</span>
            <span className={styles.end}>{p.head.fish}</span>
            <span className={styles.end}>{p.head.target}</span>
            <span>{p.head.means}</span>
          </div>
          {rows.map((row) => (
            <div key={row.stat.id} className={styles.poolRow} title={hoverOf(row.stat, words)}>
              <span className={styles.name}>
                <b>{statName(row.stat, words)}</b>
                {row.stat.sub ? <span>{row.stat.sub[words.lang]}</span> : null}
              </span>
              <span className={`${styles.poolNum} ${TONE[row.youTone] ?? ""}`} data-head={p.head.you}>
                {row.you === null ? "—" : rateIn(row.you, words, locale)}
              </span>
              <PoolNumber cell={row.reg} head={p.head.reg} />
              <PoolNumber cell={row.fish} head={p.head.fish} />
              <span className={styles.poolTarget} data-head={p.head.target}>
                {row.target === null ? "—" : p.approx(rateIn(row.target, words, locale))}
              </span>
              <span className={styles.poolMeans}>
                {row.exploits.length > 0
                  ? row.exploits.map((exploit) => (
                      <span key={exploit.types.join("+")} className={styles.poolTip}>
                        {exploitText(row.stat, exploit, words)}
                      </span>
                    ))
                  : <span className={styles.none}>{quietMeaning(row, words)}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
      <p className={styles.quiet}>{p.note}</p>
    </section>
  );
}

function PoolNumber({ cell, head }: { cell: PoolCell; head: string }) {
  const ui = useUiStrings();
  const words = ui.analytics;
  const locale = ui.intlLocale;
  return (
    <span
      className={`${styles.poolNum} ${TONE[cell.tone] ?? ""}`}
      data-head={head}
      title={cell.opp > 0 ? words.screen.pool.times(countIn(locale, cell.opp), cell.opp) : undefined}
    >
      {cell.player === null ? "—" : rateIn(cell.player, words, locale)}
    </span>
  );
}
