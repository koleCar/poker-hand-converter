/**
 * Overview under the graph (docs/ANALYTICS.md Step 7; board AN-Main,
 * "Overview"): the three costliest findings (`checkStats`' `findings`) as
 * cards - the headline, its stats against their targets, the cost - each
 * opening to its why-sentence, "Practise this ▸" and the lead stat's spots
 * (`StatSpots`, as in All stats). Below them the stats in range as pills,
 * and the ways on to All stats and Pool. With nothing off target, one line
 * and the pills.
 *
 * Pro (`lock`): the graph above stays; the findings, the pills and the
 * targets are held back behind the surface's lock.
 */
import { useState, type ReactNode } from "react";

import { useUiStrings } from "../i18n";
import { RailLoader } from "../loader/RailLoader";
import type { Catalogue, CheckerFinding, CheckerResult } from "../model/checker";
import { fixedIn } from "../stats/format";
import { SPOTS_SHOWN, StatSpots, TONE, costIn, hoverOf, rateIn } from "./AllStats";
import styles from "./Analytics.module.css";
import { findingHeadline, findingWhy, statName } from "./findings";
import { overviewOf, practiseQuery, type AnalyticsView } from "./view";

export interface OverviewProps {
  catalogue: Catalogue;
  /** The checker's result; null while it loads, on the Free plan, or with no checker. */
  result: CheckerResult | null;
  /** The surface's Pro lock. */
  lock?: ReactNode;
  loading?: boolean;
  error?: string | null;
  /** The filter sets groups the checker does not follow. */
  partial?: boolean;
  /** Another tab: All stats, Pool. */
  onView: (view: AnalyticsView) => void;
  /** The Trainer's link for a finding's query (`practiseQuery`); absent: "Practise this" is not offered. */
  practiseHref?: (query: string) => string;
}

export function Overview({ catalogue, result, lock, loading = false, error = null, partial = false, onView, practiseHref }: OverviewProps) {
  const ui = useUiStrings();
  const words = ui.analytics;
  const s = words.screen;
  const o = s.overview;
  const locale = ui.intlLocale;
  const locked = lock !== undefined && lock !== null;
  // The first card is open (the board's); a click opens another or closes it.
  const [open, setOpen] = useState<number | null>(0);

  const links = (
    <div className={styles.links}>
      <button type="button" className={styles.link} onClick={() => onView("stats")}>
        {o.allStats}
      </button>
      <button type="button" className={styles.link} onClick={() => onView("pool")}>
        {o.pool}
      </button>
    </div>
  );
  if (locked) {
    return (
      <section className={styles.overview} aria-label={o.findings}>
        {lock}
        {links}
      </section>
    );
  }
  if (result === null) {
    if (error !== null) return <p className={styles.quiet} role="alert">{o.error(error)}</p>;
    if (loading) return <RailLoader size="small" label={s.stats.loading} showLabel centered />;
    return null;
  }
  const model = overviewOf(result);
  return (
    <section className={styles.overview} aria-label={o.findings}>
      {result.pending > 0 ? <p className={styles.quiet} role="status">{s.stats.pending}</p> : null}
      {partial ? <p className={styles.quiet}>{s.stats.partial}</p> : null}
      {model.state === "findings" ? (
        <div className={styles.findings}>
          {model.findings.map((finding, index) => (
            <FindingCard
              key={`${finding.family}-${finding.lean}`}
              catalogue={catalogue}
              result={result}
              finding={finding}
              number={index + 1}
              open={open === index}
              onToggle={() => setOpen(open === index ? null : index)}
              practiseHref={practiseHref}
            />
          ))}
        </div>
      ) : (
        <p className={styles.quiet}>{model.state === "clear" ? o.clear : o.unanalysed}</p>
      )}
      {model.inRange.length > 0 ? (
        <div className={styles.inRange}>
          <span className={styles.sub}>{o.inRange}</span>
          <div className={styles.pills}>
            {model.inRange.map((figures) => {
              const stat = catalogue.get(figures.id);
              if (!stat || figures.player === null) return null;
              return (
                <span key={stat.id} className={styles.pill} title={hoverOf(stat, words)}>
                  {statName(stat, words)} <b>{rateIn(figures.player, words, locale)}</b>
                </span>
              );
            })}
          </div>
        </div>
      ) : null}
      {links}
    </section>
  );
}

function FindingCard({
  catalogue,
  result,
  finding,
  number,
  open,
  onToggle,
  practiseHref,
}: {
  catalogue: Catalogue;
  result: CheckerResult;
  finding: CheckerFinding;
  number: number;
  open: boolean;
  onToggle: () => void;
  practiseHref?: (query: string) => string;
}) {
  const ui = useUiStrings();
  const words = ui.analytics;
  const s = words.screen;
  const locale = ui.intlLocale;
  const lead = catalogue.get(finding.lead);
  const cost = costIn(finding.cost, locale);
  return (
    <div className={styles.finding}>
      <button type="button" className={`${styles.findingHead}${open ? ` ${styles.open}` : ""}`} aria-expanded={open} onClick={onToggle}>
        <span className={styles.findingNumber}>{number}</span>
        <span className={styles.findingBody}>
          <span className={styles.headline}>{findingHeadline(catalogue, finding, words)}</span>
          <span className={styles.evidence}>
            {finding.stats.map(({ id }) => {
              const stat = catalogue.get(id);
              const figures = result.stats.find((entry) => entry.id === id);
              if (!stat || !figures || figures.player === null) return null;
              return (
                <span key={id} title={hoverOf(stat, words)}>
                  {statName(stat, words)} <b className={TONE[figures.tone] ?? styles.none}>{rateIn(figures.player, words, locale)}</b>
                  {figures.bandLow !== null && figures.bandHigh !== null ? (
                    <span className={styles.dim}>
                      {" "}
                      {s.overview.target(s.stats.range(fixedIn(locale, 0)(figures.bandLow), fixedIn(locale, 0)(figures.bandHigh)))}
                    </span>
                  ) : null}
                </span>
              );
            })}
          </span>
        </span>
        <span className={`${styles.findingCost}${cost ? ` ${styles.loss}` : ""}`}>
          {cost ?? "—"}
          <span>{s.figures.per100(s.figures.bb)}</span>
        </span>
      </button>
      {open ? (
        <div className={styles.findingDetail}>
          <div className={styles.why}>
            <p>{findingWhy(catalogue, finding, words, locale)}</p>
            {practiseHref ? (
              <a className="btn btn--primary btn--sm" href={practiseHref(practiseQuery(finding))}>
                {s.overview.practise}
              </a>
            ) : null}
          </div>
          {lead ? <StatSpots catalogue={catalogue} result={result} stat={lead} className={styles.findingSpots} limit={SPOTS_SHOWN} /> : null}
        </div>
      ) : null}
    </div>
  );
}
