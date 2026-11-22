/**
 * All stats (docs/ANALYTICS.md Step 5; board AN-Main, "All stats"): every
 * catalogue stat in a row - the player's number, the band track (the
 * target's band in green, a dot for the player), the band as the target, the
 * gap in words, the analysed decisions and the cost in bb/100. Grouped by
 * street or ordered by cost; all stats or only those off target (the
 * controls are `AllStatsControls`, in the screen's tab row). A row opens to
 * its spots: the player's fold / call / raise over the target's, the gap and
 * the cost. A hover on a row says what it counts and where its target comes
 * from.
 *
 * Pro (`lock`): the player's own numbers stay (the coded twins from the
 * rollups); targets, gaps, costs and the spots are held back behind the
 * surface's one-line lock.
 */
import { Fragment, useMemo, useState, type ReactNode } from "react";

import { countIn } from "../hands/format";
import { useUiStrings, type AnalyticsStrings } from "../i18n";
import { RailLoader } from "../loader/RailLoader";
import type { Catalogue, CatalogueStat, CheckerResult, CheckerRow, CodedIn } from "../model/checker";
import { fixedIn } from "../stats/format";
import { gapText, statName } from "./findings";
import { spotName } from "./spot";
import styles from "./Analytics.module.css";
import {
  allStatsItems,
  isOff,
  spotLines,
  type AllStatsOrder,
  type AllStatsRow,
  type AllStatsShow,
  type BarAction,
  type BarPart,
} from "./view";

/** A rate in the reader's locale: one decimal under 10, whole above. */
function rateIn(value: number, words: AnalyticsStrings, locale: string): string {
  return words.checker.percent(fixedIn(locale, value < 10 ? 1 : 0)(value));
}

/** A cost as a loss: "−1.3", or "—" under 0.05 bb/100. */
function costIn(cost: number, locale: string): string | null {
  return cost >= 0.05 ? `−${fixedIn(locale, 1)(cost)}` : null;
}

const TONE: Record<string, string | undefined> = {
  ok: styles.ok,
  off: styles.off,
  far: styles.far,
  few: styles.few,
};

/** The two hover lines: what the stat counts, where its target comes from. */
function hoverOf(stat: CatalogueStat, words: AnalyticsStrings): string {
  const s = words.screen.stats;
  const from =
    stat.kind === "share" ? "share" : stat.kind === "coded" || stat.street === "showdown" ? "none" : stat.street === "preflop" ? "charts" : "solver";
  return [s.counts[stat.id] ?? statName(stat, words), s.targetFrom[from]].filter(Boolean).join("\n");
}

export function AllStatsControls({
  order,
  onOrder,
  show,
  onShow,
}: {
  order: AllStatsOrder;
  onOrder: (order: AllStatsOrder) => void;
  show: AllStatsShow;
  onShow: (show: AllStatsShow) => void;
}) {
  const s = useUiStrings().analytics.screen.stats;
  const chip = (on: boolean) => `chip-btn${on ? " is-active" : ""}`;
  return (
    <div className={styles.controls}>
      <div className={styles.seg} role="group" aria-label={s.order}>
        <button type="button" className={chip(order === "street")} aria-pressed={order === "street"} onClick={() => onOrder("street")}>
          {s.byStreet}
        </button>
        <button type="button" className={chip(order === "cost")} aria-pressed={order === "cost"} onClick={() => onOrder("cost")}>
          {s.byCost}
        </button>
      </div>
      <div className={styles.seg} role="group" aria-label={s.show}>
        <button type="button" className={chip(show === "all")} aria-pressed={show === "all"} onClick={() => onShow("all")}>
          {s.all}
        </button>
        <button type="button" className={chip(show === "off")} aria-pressed={show === "off"} onClick={() => onShow("off")}>
          {s.off}
        </button>
      </div>
    </div>
  );
}

export interface AllStatsProps {
  catalogue: Catalogue;
  /** The checker's result; null while it loads, on the Free plan, or with no checker. */
  result: CheckerResult | null;
  /** The player's coded statistics from the rollups, by catalogue id. */
  coded: Readonly<Record<string, CodedIn>>;
  order: AllStatsOrder;
  show: AllStatsShow;
  /** The surface's one-line Pro lock: targets, gaps, costs and spots held back. */
  lock?: ReactNode;
  loading?: boolean;
  error?: string | null;
  /** The filter sets groups the checker does not follow. */
  partial?: boolean;
}

export function AllStats({ catalogue, result, coded, order, show, lock, loading = false, error = null, partial = false }: AllStatsProps) {
  const ui = useUiStrings();
  const words = ui.analytics;
  const s = words.screen.stats;
  const locked = lock !== undefined && lock !== null;
  const [open, setOpen] = useState<string | null>(null);
  const items = useMemo(() => allStatsItems(catalogue, locked ? null : result, coded, order, show), [catalogue, result, coded, order, show, locked]);

  if (!locked && result === null) {
    if (error !== null) return <p className={styles.quiet} role="alert">{s.error(error)}</p>;
    if (loading) return <RailLoader size="small" label={s.loading} showLabel centered />;
  }
  const rows = items.filter((item): item is AllStatsRow => item.kind === "stat");
  const nothing = rows.every((row) => row.player === null);

  return (
    <section className={styles.list} aria-label={words.screen.tabs.stats}>
      {locked ? lock : null}
      {!locked && result && result.pending > 0 ? <p className={styles.quiet} role="status">{s.pending}</p> : null}
      {!locked && partial ? <p className={styles.quiet}>{s.partial}</p> : null}
      {show === "off" && rows.length === 0 ? (
        <p className={styles.quiet}>{s.noneOff}</p>
      ) : nothing && show === "all" ? (
        <p className={styles.quiet}>{s.empty}</p>
      ) : (
        <>
          <div className={styles.head} aria-hidden="true">
            <span>{s.heads.stat}</span>
            <span className={styles.end}>{s.heads.you}</span>
            <span>{s.heads.track}</span>
            <span className={styles.end}>{s.heads.target}</span>
            <span>{s.heads.gap}</span>
            <span className={styles.end}>{s.heads.times}</span>
            <span className={styles.end}>{words.screen.figures.per100(words.screen.figures.bb)}</span>
          </div>
          {items.map((item) =>
            item.kind === "street" ? (
              <div key={`street-${item.street}`} className={styles.street} role="presentation">
                {words.checker.streets[item.street] ?? item.street}
              </div>
            ) : (
              <Fragment key={item.stat.id}>
                <StatRow
                  row={item}
                  order={order}
                  open={!locked && open === item.stat.id}
                  locked={locked}
                  onToggle={() => setOpen(open === item.stat.id ? null : item.stat.id)}
                />
                {!locked && open === item.stat.id ? <StatDetail catalogue={catalogue} result={result} row={item} /> : null}
              </Fragment>
            ),
          )}
        </>
      )}
    </section>
  );
}

function StatRow({
  row,
  order,
  open,
  locked,
  onToggle,
}: {
  row: AllStatsRow;
  order: AllStatsOrder;
  open: boolean;
  locked: boolean;
  onToggle: () => void;
}) {
  const ui = useUiStrings();
  const words = ui.analytics;
  const s = words.screen.stats;
  const locale = ui.intlLocale;
  const { stat, checked } = row;
  const tone = TONE[row.tone] ?? "";
  const judged = !locked && checked !== null && !row.fromRollups;
  const name = order === "cost" ? statName(stat, words) : stat.label[words.lang];
  const cost = judged ? costIn(row.cost, locale) : null;
  const coverage = judged && checked.coverage !== null && checked.coverage < 0.9 ? checked.coverage : null;
  const className = [styles.row, open ? styles.open : "", locked ? styles.still : ""].filter(Boolean).join(" ");
  const cells = (
    <>
      <span className={styles.name}>
        <b>{name}</b>
        {stat.sub ? <span>{stat.sub[words.lang]}</span> : null}
      </span>
      <span className={`${styles.you} ${tone}`}>{row.player === null ? "—" : rateIn(row.player, words, locale)}</span>
      <span className={styles.track}>
        {judged && row.track ? (
          <>
            <i className={styles.band} style={{ insetInlineStart: `${row.track.bandLeft}%`, inlineSize: `${row.track.bandWidth}%` }} />
            {row.track.dot !== null ? (
              <i className={`${styles.dot} ${tone || styles.none}`} style={{ insetInlineStart: `${row.track.dot}%` }} />
            ) : null}
          </>
        ) : null}
      </span>
      <span className={styles.target}>
        {judged && checked.bandLow !== null && checked.bandHigh !== null
          ? s.range(fixedIn(locale, 0)(checked.bandLow), fixedIn(locale, 0)(checked.bandHigh))
          : judged || locked
            ? ""
            : "—"}
      </span>
      <span className={`${styles.gap} ${tone || styles.none}`}>
        {locked ? "" : judged ? gapText(stat, checked, words, locale) : words.checker.noTarget}
      </span>
      <span className={styles.times}>
        {row.n > 0 ? countIn(locale, row.n) : "—"}
        {coverage !== null ? <span>{s.analysed(words.checker.percent(fixedIn(locale, 0)(coverage * 100)))}</span> : null}
      </span>
      <span className={`${styles.cost} ${cost ? styles.loss : styles.nil}`}>{locked ? "" : (cost ?? "—")}</span>
    </>
  );
  if (locked) {
    return (
      <div className={className} title={hoverOf(stat, words)}>
        {cells}
      </div>
    );
  }
  return (
    <button type="button" className={className} aria-expanded={open} title={hoverOf(stat, words)} onClick={onToggle}>
      {cells}
    </button>
  );
}

/** The class a stat counts, as a bar's word. */
function actionOf(stat: CatalogueStat): BarPart["action"] | null {
  if (stat.kind !== "rate") return null;
  if (stat.class === "vpip") return "play";
  if (stat.class === "pfr") return "raise";
  return stat.class;
}

function StatDetail({ catalogue, result, row }: { catalogue: Catalogue; result: CheckerResult | null; row: AllStatsRow }) {
  const ui = useUiStrings();
  const words = ui.analytics;
  const s = words.screen.stats;
  const { stat } = row;
  const lines = useMemo(() => spotLines(catalogue, result, stat.id), [catalogue, result, stat.id]);
  if (stat.kind !== "rate") {
    return (
      <div className={styles.detail}>
        <p className={styles.how}>{hoverOf(stat, words).split("\n").join(" ")}</p>
      </div>
    );
  }
  const source = row.checked?.source ? (words.checker.source[row.checked.source] ?? s.target) : s.target;
  const hasCall = lines.some((line) => line.you?.some((part) => part.action === "call" || part.action === "play"));
  const hasRest = lines.some((line) => line.you?.some((part) => part.action === "rest"));
  const bet = stat.class === "bet";
  return (
    <div className={styles.detail}>
      {lines.length === 0 ? (
        <p className={styles.how}>{s.noSpots}</p>
      ) : (
        <>
          <div className={styles.spotHead} aria-hidden="true">
            <span>{s.spots.spot}</span>
            <span className={styles.end}>{s.heads.times}</span>
            <span>{s.spots.you}</span>
            <span>{source}</span>
            <span>{s.heads.gap}</span>
            <span className={styles.end}>{words.screen.figures.per100(words.screen.figures.bb)}</span>
          </div>
          {lines.map((line) => (
            <SpotRow key={line.row.key} stat={stat} row={line.row} you={line.you} target={line.target} bet={bet} />
          ))}
        </>
      )}
      <div className={styles.links}>
        <span className={styles.key}>
          {bet ? (
            <span>
              <i className={styles.bet} />
              {s.bars.bet}
            </span>
          ) : (
            <>
              <span>
                <i className={styles.fold} />
                {s.bars.fold}
              </span>
              {hasCall ? (
                <span>
                  <i className={styles.call} />
                  {s.bars.call}
                </span>
              ) : null}
              <span>
                <i className={styles.raise} />
                {s.bars.raise}
              </span>
            </>
          )}
          {hasRest || bet ? <span>{bet ? s.bars.check : s.bars.other}</span> : null}
          <span>{s.key}</span>
        </span>
      </div>
    </div>
  );
}

function SpotRow({
  stat,
  row,
  you,
  target,
  bet,
}: {
  stat: CatalogueStat;
  row: CheckerRow;
  you: BarPart[] | null;
  target: BarPart[] | null;
  bet: boolean;
}) {
  const ui = useUiStrings();
  const words = ui.analytics;
  const s = words.screen.stats;
  const locale = ui.intlLocale;
  const name = spotName(row.key, words.spot);
  const action = actionOf(stat);
  const named = action === null || action === "rest" ? null : s.bars[action];
  const label = (part: BarPart) =>
    part.action === "rest" ? (bet ? s.bars.check : s.bars.other) : s.bars[part.action as Exclude<BarAction, "rest">];
  const gap =
    row.player !== null && row.target !== null && named
      ? s.spotGap(named, rateIn(row.player, words, locale), rateIn(row.target, words, locale))
      : row.player !== null
        ? rateIn(row.player, words, locale)
        : words.checker.noTarget;
  const cost = isOff(row.tone) || row.tone === "few" ? costIn(row.cost, locale) : null;
  const bar = (parts: BarPart[] | null, who: string, ref: boolean) =>
    parts ? (
      <span
        className={`${styles.fcr}${ref ? ` ${styles.ref}` : ""}`}
        role="img"
        aria-label={s.barLabel(who, parts.map((part) => `${label(part)} ${rateIn(part.value, words, locale)}`).join(", "))}
      >
        {parts.map((part, index) => (
          <i key={index} className={styles[part.action]} style={{ inlineSize: `${part.value}%` }}>
            {part.value >= 9 && part.action !== "rest" ? fixedIn(locale, 0)(part.value) : ""}
          </i>
        ))}
      </span>
    ) : (
      <span className={styles.fcr} />
    );
  return (
    <div className={styles.spot}>
      <span className={styles.spotName} title={name}>
        {name}
      </span>
      <span className={styles.n}>{countIn(locale, row.n)}</span>
      {bar(you, s.you, false)}
      {bar(target, s.target, true)}
      <span className={`${styles.gap} ${TONE[row.tone] ?? ""}`}>{gap}</span>
      <span className={`${styles.cost} ${cost ? styles.loss : styles.nil}`}>{cost ?? "—"}</span>
    </div>
  );
}

