/**
 * Streets (docs/ANALYTICS.md Step 6; board AN-Main, "Streets"): four
 * columns, preflop to river, of the catalogue's groups. A block shows the
 * player's fold / call / raise (or one action: a bet, an open raise) over the
 * target's, the gap in words and the cost; a click opens it below - its
 * stats against their targets, and the chosen stat's spots, the same as an
 * All stats row's (`StatSpots`). It reads the checker result the screen
 * already holds; no query of its own.
 *
 * Pro (`lock`): the player's own bars stay where the rollups have every part
 * (the coded twins); targets, words, costs and the spots are held back
 * behind the surface's lock.
 */
import { Fragment, useMemo, useState, type ReactNode } from "react";

import { countIn } from "../hands/format";
import { useUiStrings } from "../i18n";
import { RailLoader } from "../loader/RailLoader";
import type { Catalogue, CheckerResult, CodedIn } from "../model/checker";
import { fixedIn } from "../stats/format";
import { ActionBar, SPOTS_SHOWN, StatSpots, TONE, costIn, hoverOf, rateIn } from "./AllStats";
import styles from "./Analytics.module.css";
import { gapText, statName } from "./findings";
import { blockStats, firstOpenBlock, streetColumns, type StreetBlock } from "./view";

export interface StreetsProps {
  catalogue: Catalogue;
  /** The checker's result; null while it loads, on the Free plan, or with no checker. */
  result: CheckerResult | null;
  /** The player's coded statistics from the rollups, by catalogue id. */
  coded: Readonly<Record<string, CodedIn>>;
  /** The surface's Pro lock: targets, words, costs and spots held back. */
  lock?: ReactNode;
  loading?: boolean;
  error?: string | null;
  /** The filter sets groups the checker does not follow. */
  partial?: boolean;
}

/** The key in the tab row: the bars' colours, upper bar you, lower bar the target. */
export function StreetsKey() {
  const s = useUiStrings().analytics.screen;
  return (
    <span className={styles.key}>
      <span>
        <i className={styles.fold} />
        {s.stats.bars.fold}
      </span>
      <span>
        <i className={styles.call} />
        {s.stats.bars.call}
      </span>
      <span>
        <i className={styles.raise} />
        {s.streets.raiseBet}
      </span>
      <span className={styles.keyNote}>{s.stats.key}</span>
    </span>
  );
}

export function Streets({ catalogue, result, coded, lock, loading = false, error = null, partial = false }: StreetsProps) {
  const ui = useUiStrings();
  const words = ui.analytics;
  const s = words.screen;
  const locale = ui.intlLocale;
  const locked = lock !== undefined && lock !== null;
  const shown = locked ? null : result;
  const columns = useMemo(() => streetColumns(catalogue, shown, coded), [catalogue, shown, coded]);
  // The costliest block off target opens first (the board's); a click picks another or closes it.
  const [picked, setPicked] = useState<{ block: string | null; stat: string | null } | null>(null);
  const openId = locked ? null : picked ? picked.block : firstOpenBlock(columns);
  const open = columns.flatMap((column) => column.blocks).find((block) => block.group.id === openId) ?? null;

  if (!locked && result === null) {
    if (error !== null) return <p className={styles.quiet} role="alert">{s.stats.error(error)}</p>;
    if (loading) return <RailLoader size="small" label={s.stats.loading} showLabel centered />;
  }
  const choose = (block: StreetBlock) =>
    setPicked(openId === block.group.id ? { block: null, stat: null } : { block: block.group.id, stat: null });
  // The open block's spots: under the four columns (the board's); on a phone, where the columns stack, under its own.
  const detail = (where: string) =>
    open ? (
      <OpenBlock
        catalogue={catalogue}
        result={result}
        block={open}
        chosen={picked?.block === open.group.id ? picked.stat : null}
        onChoose={(stat) => setPicked({ block: open.group.id, stat })}
        className={where}
      />
    ) : null;

  return (
    <section className={styles.streetsTab} aria-label={s.tabs.streets}>
      {locked ? lock : null}
      {!locked && result && result.pending > 0 ? <p className={styles.quiet} role="status">{s.stats.pending}</p> : null}
      {!locked && partial ? <p className={styles.quiet}>{s.stats.partial}</p> : null}
      <div className={styles.columns}>
        {columns.map((column) => {
          const name = words.checker.streets[column.street] ?? column.street;
          const cost = locked ? null : costIn(column.cost, locale);
          return (
            <Fragment key={column.street}>
              <div className={styles.column} role="group" aria-label={s.streets.blocks(name)}>
                <div className={styles.columnHead}>
                  <span>{name}</span>
                  {cost ? (
                    <span className={`${styles.columnCost} ${styles.loss}`}>
                      {cost} {s.figures.per100(s.figures.bb)}
                    </span>
                  ) : null}
                </div>
                {column.blocks.map((block) => (
                  <Block
                    key={block.group.id}
                    block={block}
                    open={block.group.id === openId}
                    locked={locked}
                    onPick={() => choose(block)}
                  />
                ))}
              </div>
              {open?.group.street === column.street ? detail(styles.openNarrow) : null}
            </Fragment>
          );
        })}
      </div>
      {detail(styles.openWide)}
    </section>
  );
}

function Block({ block, open, locked, onPick }: { block: StreetBlock; open: boolean; locked: boolean; onPick: () => void }) {
  const ui = useUiStrings();
  const words = ui.analytics;
  const s = words.screen;
  const locale = ui.intlLocale;
  const bet = block.barStats.some((stat) => stat.kind === "rate" && stat.class === "bet");
  const source = block.source ? (words.checker.source[block.source] ?? s.stats.target) : s.stats.target;
  const verdict = block.verdict;
  const word = locked
    ? ""
    : verdict
      ? gapText(verdict.stat, verdict.figures, words, locale)
      : block.fromRollups
        ? words.checker.noTarget
        : "";
  const cost = locked ? null : costIn(block.cost, locale);
  // Nothing judged in it (the Free plan, nothing analysed): nothing to open.
  const still = locked || verdict === null;
  const className = [styles.block, open ? styles.open : "", still ? styles.still : ""].filter(Boolean).join(" ");
  const label = block.group.label[words.lang];
  const cells = (
    <>
      <span className={styles.blockLabel}>
        <b>{label}</b>
        <span title={s.streets.times}>{block.n > 0 ? countIn(locale, block.n) : "—"}</span>
      </span>
      {block.you ? (
        <span className={styles.barRow}>
          <span>{s.streets.you}</span>
          <ActionBar parts={block.you} who={s.streets.you} bet={bet} />
        </span>
      ) : null}
      {block.target ? (
        <span className={styles.barRow}>
          <span>{source}</span>
          <ActionBar parts={block.target} who={source} bet={bet} reference />
        </span>
      ) : null}
      {word || cost ? (
        <span className={styles.verdict}>
          <span className={TONE[block.tone] ?? styles.none} title={verdict ? statName(verdict.stat, words) : undefined}>
            {word}
          </span>
          {cost ? <span className={`${styles.blockCost} ${styles.loss}`}>{cost}</span> : null}
        </span>
      ) : null}
    </>
  );
  if (still) return <div className={className}>{cells}</div>;
  return (
    <button type="button" className={className} aria-expanded={open} onClick={onPick}>
      {cells}
    </button>
  );
}

/** The open block: its stats against their targets (a pick when there are several), then the chosen one's spots. */
function OpenBlock({
  catalogue,
  result,
  block,
  chosen,
  onChoose,
  className,
}: {
  catalogue: Catalogue;
  result: CheckerResult | null;
  block: StreetBlock;
  chosen: string | null;
  onChoose: (stat: string) => void;
  className: string;
}) {
  const ui = useUiStrings();
  const words = ui.analytics;
  const s = words.screen;
  const locale = ui.intlLocale;
  const entries = blockStats(block, result);
  const current =
    entries.find((entry) => entry.stat.id === chosen) ??
    entries.find((entry) => entry.stat.id === block.verdict?.stat.id) ??
    entries[0];
  if (!current) return null;
  return (
    <div className={`${styles.openBlock} ${className}`}>
      <div className={styles.openStats}>
        {entries.map(({ stat, figures }) => {
          const tone = figures ? (TONE[figures.tone] ?? styles.none) : styles.none;
          const range =
            figures && figures.bandLow !== null && figures.bandHigh !== null
              ? s.streets.target(s.stats.range(fixedIn(locale, 0)(figures.bandLow), fixedIn(locale, 0)(figures.bandHigh)))
              : null;
          const line = (
            <>
              <b>{statName(stat, words)}</b>
              {figures?.player !== null && figures?.player !== undefined ? (
                <span className={`${styles.openYou} ${tone}`}>{rateIn(figures.player, words, locale)}</span>
              ) : null}
              {range ? <span className={styles.openTarget}>{range}</span> : null}
              <span className={tone}>{figures ? gapText(stat, figures, words, locale) : words.checker.noTarget}</span>
            </>
          );
          const on = stat.id === current.stat.id;
          return entries.length > 1 ? (
            <button
              key={stat.id}
              type="button"
              className={`${styles.openStat}${on ? ` ${styles.on}` : ""}`}
              aria-pressed={on}
              title={hoverOf(stat, words)}
              onClick={() => onChoose(stat.id)}
            >
              {line}
            </button>
          ) : (
            <div key={stat.id} className={styles.openStat} title={hoverOf(stat, words)}>
              {line}
            </div>
          );
        })}
      </div>
      <StatSpots key={current.stat.id} catalogue={catalogue} result={result} stat={current.stat} className={styles.openSpots} limit={SPOTS_SHOWN} />
    </div>
  );
}
