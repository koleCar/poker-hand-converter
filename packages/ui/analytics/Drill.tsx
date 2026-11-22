/**
 * The drill-down (docs/ANALYTICS.md Step 8; board AN-Drill): one stat by
 * spot, bet size and hand class, then the hands behind it. The bar names
 * the stat against its target with its cost and the way to the Trainer
 * ("Practise <spot> ▸"); the spots are on the left, the costliest first and
 * the first one open; on the right the open spot's bet sizes (fold / call /
 * raise for the player and the reference, the cost), "What you fold"
 * (strongest class first: the share of the folds, how often the solver
 * folds it, what a call is worth, "Practise ▸" on the classes off target),
 * and the decisions the solver plays differently, the costliest first, each
 * opening the hand in the surface's replayer and offering "Play it ▸".
 *
 * The figures are the checker's over the spot's (and size's) groups
 * (`drillOf` in `view.ts`); the hands are the surface's examples
 * (`AnalyticsChecker.examples`). Pro (`lock`): the bar's way back and the
 * lock only.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";

import { CardRow } from "../cards/PlayingCard";
import { countIn } from "../hands/format";
import { errorText } from "../hands/model";
import { useUiStrings, type AnalyticsStrings } from "../i18n";
import { RailLoader } from "../loader/RailLoader";
import type { Catalogue, CatalogueStat, CheckerResult, CheckerSumsIn } from "../model/checker";
import { fixedIn } from "../stats/format";
import { costIn, rateIn, TONE } from "./AllStats";
import styles from "./Analytics.module.css";
import { breakdownName, statName } from "./findings";
import type { CheckerExample, CheckerExampleQuery } from "./model";
import { parseSpot, spotName, spotSeats } from "./spot";
import {
  drillOf,
  drillQuery,
  drillSide,
  isDrillable,
  isOff,
  playQuery,
  type PractiseFigures,
  type BarAction,
  type DrillCell,
  type DrillClass,
  type DrillSize,
} from "./view";

/* ------------------------------------------------------------ links -- */

/**
 * How the screen moves into a stat's drill-down and back (the surface's
 * route): `href(stat)` for the link, `href(null)` for the way back to the
 * tabs; `go`, when given, handles a plain click itself (the web's
 * client-side move, so the screen's state stays).
 */
export interface DrillNav {
  href: (stat: string | null) => string;
  go?: ((stat: string | null) => void) | undefined;
}

export const DrillNavContext = createContext<DrillNav | null>(null);

/** A link into a drill-down (or back, `stat` null), through the surface's route. */
export function DrillLink({ stat, className, children }: { stat: string | null; className?: string; children: ReactNode }) {
  const nav = useContext(DrillNavContext);
  if (!nav) return null;
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!nav.go || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    nav.go(stat);
  };
  return (
    <a className={className} href={nav.href(stat)} onClick={onClick}>
      {children}
    </a>
  );
}

/** "By bet size and hand →" under a stat's spots, where the surface has the route and the stat a drill-down. */
export function DrillWayIn({ stat }: { stat: CatalogueStat }) {
  const nav = useContext(DrillNavContext);
  const words = useUiStrings().analytics.screen.drill;
  if (!nav || !isDrillable(stat)) return null;
  return (
    <DrillLink stat={stat.id} className={styles.link}>
      {words.link}
    </DrillLink>
  );
}

/* ------------------------------------------------------------ screen -- */

/** What the surface needs to open a hand from the drill-down's list. */
export interface DrillHandLinkProps {
  handId: string;
  /** The decision to open at (`PhfAction.index`). */
  actionIndex: number;
  /** The link's accessible name. */
  label: string;
  className: string;
  children: ReactNode;
}

export interface DrillProps {
  catalogue: Catalogue;
  statId: string;
  /** The checker's sums over the screen's filter (the spots' and sizes' groups); null while they load. */
  sums: CheckerSumsIn | null;
  result: CheckerResult | null;
  /** The surface's Pro lock: the drill-down is Pro. */
  lock?: ReactNode;
  loading?: boolean;
  error?: string | null;
  partial?: boolean;
  /** The decisions behind the open spot (and size); absent: no hands. */
  examples?: ((query: CheckerExampleQuery) => Promise<CheckerExample[]>) | undefined;
  /** A new value reads the hands again (another filter, a reload). */
  examplesKey?: string;
  /** How a hand opens (the surface's replayer). Absent: the rows are not links. */
  renderHandLink?: ((props: DrillHandLinkProps) => ReactNode) | undefined;
  /** Around the hands' list (the desktop's `HandTable`: several chosen at once). */
  wrapHands?: ((children: ReactNode, resetKey: string) => ReactNode) | undefined;
  /** The Trainer's link from its query. Absent: no "Practise" or "Play it". */
  practiseHref?: ((query: string) => string) | undefined;
}

/** The spots listed before "All N spots" (the costliest first; the open one always shows). */
const SPOTS_LISTED = 8;

/** The hands asked for, and shown, per spot (and size). */
const HANDS_ASKED = 16;
const HANDS_SHOWN = 8;

export function Drill({
  catalogue,
  statId,
  sums,
  result,
  lock,
  loading = false,
  error = null,
  partial = false,
  examples,
  examplesKey = "",
  renderHandLink,
  wrapHands,
  practiseHref,
}: DrillProps) {
  const ui = useUiStrings();
  const words = ui.analytics;
  const d = words.screen.drill;
  const s = words.screen.stats;
  const locale = ui.intlLocale;
  const locked = lock !== undefined && lock !== null;
  const stat = catalogue.get(statId);
  const [chosen, setChosen] = useState<{ spot: string | null; size: string | null }>({ spot: null, size: null });
  const [allSpots, setAllSpots] = useState(false);
  const model = useMemo(
    () => (locked ? null : drillOf(catalogue, sums, result, statId, chosen.spot, chosen.size)),
    [catalogue, sums, result, statId, chosen.spot, chosen.size, locked],
  );

  const back = (
    <DrillLink stat={null} className={styles.link}>
      {d.back}
    </DrillLink>
  );

  if (!stat || !isDrillable(stat)) {
    return (
      <section className={styles.drill}>
        <div className={styles.drillBar}>{back}</div>
        <p className={styles.quiet}>{d.noDrill}</p>
      </section>
    );
  }
  const name = statName(stat, words);
  if (locked) {
    return (
      <section className={styles.drill} aria-label={name}>
        <div className={styles.drillBar}>
          {back}
          <b className={styles.drillName}>{name}</b>
        </div>
        {lock}
      </section>
    );
  }
  if (result === null || model === null) {
    return (
      <section className={styles.drill} aria-label={name}>
        <div className={styles.drillBar}>
          {back}
          <b className={styles.drillName}>{name}</b>
        </div>
        {error !== null ? (
          <p className={styles.quiet} role="alert">
            {s.error(error)}
          </p>
        ) : loading ? (
          <RailLoader size="small" label={s.loading} showLabel centered />
        ) : (
          <p className={styles.quiet}>{s.empty}</p>
        )}
      </section>
    );
  }

  const { checked, spots, spot, sizes, size, classes } = model;
  const tone = checked ? (TONE[checked.tone] ?? "") : "";
  const cost = checked && isOff(checked.tone) ? costIn(checked.cost, locale) : null;
  const scope = spot === null ? null : sizeScope(spot, size, catalogue, words);
  // "Practise <spot> ▸" deals from the costliest classes off target (three at most).
  const keep = classes
    .filter((entry) => entry.practise)
    .sort((a, b) => b.row.cost - a.row.cost)
    .slice(0, 3)
    .map((entry) => entry.row.key);
  const action = stat.kind === "rate" ? stat.class : "";
  // The Trainer's goal reads the scope practised: the chosen size's row, else the spot's (the stat's overall without one).
  const scopeFigures = (size !== null ? sizes.find((entry) => entry.row.key === size)?.row : undefined) ?? spots.find((row) => row.key === spot) ?? checked;

  return (
    <section className={styles.drill} aria-label={name}>
      <div className={styles.drillBar}>
        {back}
        <b className={styles.drillName}>{name}</b>
        {checked?.player !== null && checked?.player !== undefined ? (
          <span className={`${styles.drillYou} ${tone}`}>{rateIn(checked.player, words, locale)}</span>
        ) : null}
        {checked && checked.bandLow !== null && checked.bandHigh !== null ? (
          <span className={styles.drillTarget}>
            {d.target(
              s.range(fixedIn(locale, 0)(checked.bandLow), fixedIn(locale, 0)(checked.bandHigh)),
              (checked.source && words.checker.source[checked.source]) || s.target,
            )}
          </span>
        ) : null}
        {cost ? <span className={styles.drillCost}>{`${cost} ${words.screen.figures.per100(words.screen.figures.bb)}`}</span> : null}
        <span className={styles.spacer} />
        {practiseHref && spot !== null && scope !== null ? (
          <a className="btn btn--primary btn--sm" href={practiseHref(drillQuery(stat.id, spot, size, keep, scopeFigures))}>
            {d.practise(scope)}
          </a>
        ) : null}
      </div>
      {result.pending > 0 ? (
        <p className={styles.quiet} role="status">
          {s.pending}
        </p>
      ) : null}
      {partial ? <p className={styles.quiet}>{s.partial}</p> : null}
      {spots.length === 0 || spot === null ? (
        <p className={styles.quiet}>{checked && checked.n === 0 ? words.screen.overview.unanalysed : s.noSpots}</p>
      ) : (
        <div className={styles.split}>
          <div className={styles.spotList} role="group" aria-label={d.spots}>
            {(allSpots ? spots : spots.filter((row, index) => index < SPOTS_LISTED || row.key === spot)).map((row) => {
              const parts = parseSpot(row.key);
              const rest = spotName(row.key, words.spot).slice(spotSeats(parts, words.spot).length).replace(/^ · /, "");
              const on = row.key === spot;
              return (
                <button
                  key={row.key}
                  type="button"
                  className={`${styles.spotBtn}${on ? ` ${styles.on}` : ""}`}
                  aria-pressed={on}
                  title={spotName(row.key, words.spot)}
                  onClick={() => setChosen({ spot: row.key, size: null })}
                >
                  <b>{spotSeats(parts, words.spot)}</b>
                  <span className={`${styles.spotV} ${TONE[row.tone] ?? ""}`}>
                    {row.player === null ? "—" : rateIn(row.player, words, locale)}
                  </span>
                  <span className={styles.spotSub}>
                    {[rest, d.times(countIn(locale, row.n), row.n)].filter(Boolean).join(words.spot.separator)}
                  </span>
                  <span className={`${styles.spotV} ${styles.dim}`}>
                    {row.target === null ? "" : rateIn(row.target, words, locale)}
                  </span>
                </button>
              );
            })}
            {spots.length > SPOTS_LISTED ? (
              <button type="button" className={`${styles.link} ${styles.spotMore}`} aria-expanded={allSpots} onClick={() => setAllSpots(!allSpots)}>
                {allSpots ? s.fewerSpots : s.allSpots(countIn(locale, spots.length))}
              </button>
            ) : null}
          </div>
          <div className={styles.drillMain}>
            {sizes.length > 0 ? (
              <SizeTable
                catalogue={catalogue}
                sizes={sizes}
                actions={model.actions}
                size={size}
                source={checked?.source ?? "solver"}
                onSize={(next) => setChosen({ spot, size: next === size ? null : next })}
              />
            ) : null}
            {classes.length > 0 && scope !== null ? (
              <ClassTable
                classes={classes}
                action={action}
                scope={scope}
                catalogue={catalogue}
                practise={
                  practiseHref
                    ? (cls) => practiseHref(drillQuery(stat.id, spot, size, [cls], classes.find((entry) => entry.row.key === cls)?.row ?? scopeFigures))
                    : undefined
                }
              />
            ) : null}
            {examples ? (
              <HandList
                key={`${stat.id}|${spot}|${size ?? ""}`}
                stat={stat}
                spot={spot}
                size={size}
                side={drillSide(checked)}
                catalogue={catalogue}
                examples={examples}
                examplesKey={examplesKey}
                renderHandLink={renderHandLink}
                wrapHands={wrapHands}
                practiseHref={practiseHref}
                figures={scopeFigures}
              />
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}

/** "BB vs SB · Single-raised pot · as the caller", and the size when one is chosen. */
function sizeScope(spot: string, size: string | null, catalogue: Catalogue, words: AnalyticsStrings): string {
  const name = spotName(spot, words.spot);
  return size === null ? name : `${name}${words.spot.separator}${breakdownName(catalogue, "size", size, words)}`;
}

/** A stat's action class as a word: Fold, Call, Raise, Bet, Play. */
function classActionWord(cls: string, words: AnalyticsStrings, bet: boolean): string {
  return actionWord(cls === "vpip" ? "play" : cls === "pfr" ? "raise" : (cls as BarAction), words, bet);
}

/** The bar part's word in a head: Fold, Call, Raise, Bet, Check, Other. */
function actionWord(action: BarAction, words: AnalyticsStrings, bet: boolean): string {
  const bars = words.screen.stats.bars;
  if (action === "rest") return bet ? bars.check : bars.other;
  return bars[action];
}

function SizeTable({
  catalogue,
  sizes,
  actions,
  size,
  source,
  onSize,
}: {
  catalogue: Catalogue;
  sizes: DrillSize[];
  actions: BarAction[];
  size: string | null;
  source: string;
  onSize: (size: string) => void;
}) {
  const ui = useUiStrings();
  const words = ui.analytics;
  const d = words.screen.drill;
  const locale = ui.intlLocale;
  const bet = actions.includes("bet");
  const columns = { "--cells": String(Math.max(1, actions.length)) } as CSSProperties;
  return (
    <div className={styles.sizes} role="group" aria-label={d.sizes.label}>
      <div className={styles.sizeHead} style={columns} aria-hidden="true">
        <span>{d.sizes.size}</span>
        <span className={styles.end}>{d.sizes.times}</span>
        {actions.map((action, index) => (
          <span key={action} className={styles.end}>
            {index === 0 ? d.sizes.youRef(actionWord(action, words, bet), d.sizes.ref[source] ?? source) : actionWord(action, words, bet)}
          </span>
        ))}
        <span className={styles.end}>{words.screen.figures.per100(words.screen.figures.bb)}</span>
      </div>
      {sizes.map(({ row, cells }) => {
        const on = row.key === size;
        const cost = isOff(row.tone) || row.tone === "few" ? costIn(row.cost, locale) : null;
        return (
          <button
            key={row.key}
            type="button"
            className={`${styles.sizeRow}${on ? ` ${styles.on}` : ""}`}
            style={columns}
            aria-pressed={on}
            onClick={() => onSize(row.key)}
          >
            <span className={styles.sizeName}>{breakdownName(catalogue, "size", row.key, words)}</span>
            <span className={styles.dim}>{countIn(locale, row.n)}</span>
            {cells.map((cell) => (
              <SizeCell key={cell.action} cell={cell} />
            ))}
            <span className={`${styles.cost} ${cost ? styles.loss : styles.nil}`}>{cost ?? "—"}</span>
          </button>
        );
      })}
    </div>
  );
}

function SizeCell({ cell }: { cell: DrillCell }) {
  const ui = useUiStrings();
  const words = ui.analytics;
  const locale = ui.intlLocale;
  return (
    <span className={styles.cell}>
      <b className={TONE[cell.tone] ?? ""}>{cell.you === null ? "—" : rateIn(cell.you, words, locale)}</b>
      <span>{cell.target === null ? "" : rateIn(cell.target, words, locale)}</span>
    </span>
  );
}

function ClassTable({
  classes,
  action,
  scope,
  catalogue,
  practise,
}: {
  classes: DrillClass[];
  action: string;
  scope: string;
  catalogue: Catalogue;
  practise?: ((cls: string) => string) | undefined;
}) {
  const ui = useUiStrings();
  const words = ui.analytics;
  const d = words.screen.drill;
  const locale = ui.intlLocale;
  // The bars are scaled to the largest share (a fraction of the stat's actions).
  const most = Math.max(...classes.map((entry) => entry.row.shareOfTaken ?? 0), 0.01);
  const bet = action === "bet";
  return (
    <div className={styles.classes}>
      <span className={styles.sub}>{d.classesTitle(d.what[action] ?? action, scope)}</span>
      <div className={`${styles.classRow} ${styles.classHead}`} aria-hidden="true">
        <span>{d.classHead}</span>
        <span>{d.share[action] ?? ""}</span>
        <span className={styles.end}>{d.sizes.youRef(classActionWord(action, words, bet), d.sizes.ref.solver ?? "")}</span>
        <span className={styles.end}>{d.worth[action] ?? d.worth.other}</span>
        <span />
      </div>
      {classes.map(({ row, practise: offered }) => {
        const share = row.shareOfTaken;
        const worth = row.worth !== null && row.worth >= 0.005 ? d.bb(fixedIn(locale, 2)(row.worth)) : null;
        const tone = TONE[row.tone] ?? "";
        return (
          <div key={row.key} className={styles.classRow}>
            <span className={styles.className}>{breakdownName(catalogue, "class", row.key, words)}</span>
            <span className={styles.shareCell}>
              <span className={styles.share}>
                <i
                  className={isOff(row.tone) ? tone : undefined}
                  style={{ inlineSize: `${share === null ? 0 : Math.min(100, (share / most) * 100)}%` }}
                />
              </span>
              <span className={styles.shareText}>{share === null ? "—" : rateIn(share * 100, words, locale)}</span>
            </span>
            <span className={`${styles.end} ${styles.cell}`}>
              <b className={tone}>{row.player === null ? "—" : rateIn(row.player, words, locale)}</b>
              <span>{row.target === null ? "" : rateIn(row.target, words, locale)}</span>
            </span>
            <span className={`${styles.end} ${worth ? styles.gain : styles.dim}`}>{worth ?? "—"}</span>
            <span className={styles.end}>
              {practise && offered ? (
                <a className={styles.link} href={practise(row.key)}>
                  {d.practiseClass}
                </a>
              ) : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function HandList({
  stat,
  spot,
  size,
  side,
  catalogue,
  examples,
  examplesKey,
  renderHandLink,
  wrapHands,
  practiseHref,
  figures = null,
}: {
  stat: CatalogueStat;
  spot: string;
  size: string | null;
  side: "high" | "low";
  catalogue: Catalogue;
  examples: (query: CheckerExampleQuery) => Promise<CheckerExample[]>;
  examplesKey: string;
  renderHandLink?: ((props: DrillHandLinkProps) => ReactNode) | undefined;
  wrapHands?: ((children: ReactNode, resetKey: string) => ReactNode) | undefined;
  practiseHref?: ((query: string) => string) | undefined;
  /** The scope's figures, for the Trainer's goal panel ("Play it ▸"). */
  figures?: PractiseFigures | null;
}) {
  const ui = useUiStrings();
  const words = ui.analytics;
  const d = words.screen.drill;
  const [state, setState] = useState<{ key: string; rows: CheckerExample[] | null; error: string | null } | null>(null);
  const generation = useRef(0);
  const key = `${examplesKey}#${side}`;

  useEffect(() => {
    const mine = ++generation.current;
    examples({ stat: stat.id, spot, size, side, limit: HANDS_ASKED })
      .then((rows) => {
        if (mine === generation.current) setState({ key, rows, error: null });
      })
      .catch((reason: unknown) => {
        if (mine === generation.current) setState({ key, rows: null, error: errorText(reason) });
      });
  }, [examples, stat.id, spot, size, side, key]);

  const action = stat.kind === "rate" ? stat.class : "";
  const title = d.handsTitle((side === "low" ? d.handsLow : d.handsHigh)[action] ?? "");
  const current = state?.key === key ? state : null;
  const rows = (current?.rows ?? []).filter((row) => row.evLossBb >= 0.005).slice(0, HANDS_SHOWN);

  let body: ReactNode;
  if (current === null) {
    body = <RailLoader size="inline" label={d.handsLoading} showLabel />;
  } else if (current.error !== null) {
    body = (
      <p className={styles.quiet} role="alert">
        {d.handsError(current.error)}
      </p>
    );
  } else if (rows.length === 0) {
    body = <p className={styles.quiet}>{d.noHands}</p>;
  } else {
    const list = (
      <DrillHandRows stat={stat} rows={rows} catalogue={catalogue} renderHandLink={renderHandLink} practiseHref={practiseHref} figures={figures} />
    );
    body = wrapHands ? wrapHands(list, `${stat.id}|${spot}|${size ?? ""}`) : list;
  }

  return (
    <div className={styles.handsBox}>
      <span className={styles.sub}>{title}</span>
      {body}
    </div>
  );
}

/**
 * The hands behind a spot, the costliest first: the hero's cards, the board,
 * the bet size, the hand class and what the other way was worth, the row a
 * link to the hand (the surface's `renderHandLink`) and "Play it ▸" beside it.
 */
export function DrillHandRows({
  stat,
  rows,
  catalogue,
  renderHandLink,
  practiseHref,
  figures = null,
}: {
  stat: CatalogueStat;
  rows: readonly CheckerExample[];
  catalogue: Catalogue;
  renderHandLink?: ((props: DrillHandLinkProps) => ReactNode) | undefined;
  practiseHref?: ((query: string) => string) | undefined;
  /** The scope's figures, for the Trainer's goal panel. */
  figures?: PractiseFigures | null;
}) {
  const ui = useUiStrings();
  const words = ui.analytics;
  const d = words.screen.drill;
  const locale = ui.intlLocale;
  return (
    <div className={styles.hands}>
      {rows.map((row) => {
        // Preflop there is no board and no bet size: the cards, the spot and the worth only.
        const bare = row.board.length === 0 && !row.size;
        const cells = (
          <>
            <span className={styles.handCards}>{row.cards.length > 0 ? <CardRow cards={row.cards} size="xs" /> : "—"}</span>
            {bare ? null : (
              <>
                <span className={styles.handCards}>{row.board.length > 0 ? <CardRow cards={row.board} size="xs" /> : null}</span>
                <span className={styles.dim}>{row.size ? breakdownName(catalogue, "size", row.size, words) : ""}</span>
              </>
            )}
            <span className={styles.handWhat}>
              {row.handClass ? breakdownName(catalogue, "class", row.handClass, words) : spotName(row.spot, words.spot)}
            </span>
            <span className={styles.handEv}>{d.bb(fixedIn(locale, 2)(row.evLossBb))}</span>
          </>
        );
        const linkClass = bare ? `${styles.handLink} ${styles.bare}` : styles.handLink;
        const label = d.openHand(row.cards.join(" ") || row.handId);
        return (
          <div key={`${row.handId}-${row.ord}`} className={styles.handRow}>
            {renderHandLink ? (
              renderHandLink({ handId: row.handId, actionIndex: row.actionIndex, label, className: linkClass, children: cells })
            ) : (
              <span className={linkClass}>{cells}</span>
            )}
            {practiseHref ? (
              <a className={styles.link} href={practiseHref(playQuery(stat.id, row, figures))}>
                {d.playIt}
              </a>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
