/**
 * Session review (R5.1; guideline §9): after a session, the hands worth a
 * look - its worst graded decisions, its preflop decisions off the user's
 * charts, its biggest pots - and a short summary of it.
 *
 * Shared so the desktop app can render it once the analysis is there
 * (R5.4); today the web does, at `/analysis/session`. What is the surface's:
 * the data (`SessionReviewSource`), where the deviations come from
 * (`DeviationSource`; the shipped charts by default, the user's own with
 * R5.3), how a hand opens (`renderHandLink`: the web's `/analysis/h/<id>`,
 * at the decision), what to offer when hands are not analysed yet
 * (`coverageAction`), and the states' look.
 *
 * Off-table only (A10): a surface that knows a poker table is open passes
 * `hiddenDuringPlay` and nothing of the review is rendered or read. By
 * default the screen opens the latest session that has *ended*; one that
 * may still be going on is named, and opened only when asked for.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { CardRow } from "../cards/PlayingCard";
import { bigBlindsIn, countIn, signedMoney, unitOf } from "../hands/format";
import { errorText } from "../hands/model";
import { useUiStrings } from "../i18n";
import { dateFormat, numberFormat } from "../stats/format";
import {
  shippedChartDeviations,
  type DeviationSource,
  type ReviewDecision,
  type ReviewHand,
  type SessionListItem,
  type SessionQuery,
  type SessionReview,
  type SessionReviewSource,
} from "./model";
import styles from "./Review.module.css";
import { bbPer100, minutesBetween, selectWorthALook, type ReviewItem, type ReviewSection } from "./select";

/** Hands shown per list. */
export const REVIEW_SHOWN = 6;
/** Hands asked for per list: room for the de-duplication to fill each list up. */
export const REVIEW_FETCHED = 20;

/** Glyphs, not words (the web's `GradeIcon`): the shape carries the grade in greyscale too. */
const GRADE_GLYPHS: Record<string, string> = {
  perfect: "★",
  good: "✓",
  inaccurate: "?!",
  mistake: "?",
  blunder: "??",
};

export interface HandLinkProps {
  handId: string;
  /** The decision to open at (`PhfAction.index`); null: the hand's own default. */
  actionIndex: number | null;
  /** The reviewed session's start, for a way back to it. */
  sessionAt: string;
  /** The link's accessible name. */
  label: string;
  className: string;
  children: ReactNode;
}

export interface SessionReviewScreenProps {
  source: SessionReviewSource;
  /** Where the preflop deviations come from; the shipped charts by default. */
  deviationSource?: DeviationSource;
  /**
   * The sources the reader may pick from (R5.3: Rail's charts and the user's
   * own), shown as a choice over the deviations list when there is more
   * than one; `onDeviationSource` gets the picked id.
   */
  deviationChoices?: ReadonlyArray<{ id: string; label: string }> | undefined;
  onDeviationSource?: ((id: string) => void) | undefined;
  query: SessionQuery;
  /** Another session (an instant in it), or the same one without the filter. */
  onQuery: (query: SessionQuery) => void;
  renderHandLink: (props: HandLinkProps) => ReactNode;
  title: string;
  titleTag?: "h1" | "h2";
  /** Under the title: the surface's own navigation or lines. */
  notice?: ReactNode;
  /** The loading and error states, in the surface's own look. */
  renderState: (kind: "loading" | "empty" | "error", text: string) => ReactNode;
  /** Beside "not analysed yet": the surface's way to analyse them. */
  coverageAction?: ReactNode;
  /** A10: a poker table is open - show nothing of the review, read nothing. */
  hiddenDuringPlay?: boolean;
  /** A new value reads the session again (hands arrived, an analysis run ended). */
  reloadToken?: unknown;
}

type Loaded =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      key: string;
      review: SessionReview;
      deviations: ReviewDecision[];
      deviationHands: Record<string, ReviewHand>;
      source: DeviationSource;
    };

const keyOf = (query: SessionQuery) => JSON.stringify([query.at, query.gapMinutes, query.filter]);
const listKeyOf = (query: SessionQuery) => JSON.stringify([query.gapMinutes, query.filter]);

export function SessionReviewScreen({
  source,
  deviationSource = shippedChartDeviations,
  deviationChoices,
  onDeviationSource,
  query,
  onQuery,
  renderHandLink,
  title,
  titleTag: Title = "h1",
  notice,
  renderState,
  coverageAction,
  hiddenDuringPlay = false,
  reloadToken = 0,
}: SessionReviewScreenProps) {
  const r = useUiStrings().review;
  const key = keyOf(query);
  const listKey = listKeyOf(query);
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [sessions, setSessions] = useState<{ key: string; items: SessionListItem[] } | null>(null);

  useEffect(() => {
    if (hiddenDuringPlay) return;
    let live = true;
    const asked = JSON.parse(key) as [string | null, number, SessionQuery["filter"]];
    const current: SessionQuery = { at: asked[0], gapMinutes: asked[1], filter: asked[2] };
    void (async () => {
      try {
        const review = await source.review(current, REVIEW_FETCHED);
        const list = review.session ? await deviationSource.deviations(review, current) : { decisions: [] };
        if (live) {
          setLoaded({
            status: "ready",
            key,
            review,
            deviations: list.decisions,
            deviationHands: list.hands ?? {},
            source: deviationSource,
          });
        }
      } catch (error) {
        if (live) setLoaded({ status: "error", message: errorText(error) });
      }
    })();
    return () => {
      live = false;
    };
  }, [key, source, deviationSource, reloadToken, hiddenDuringPlay]);

  useEffect(() => {
    if (hiddenDuringPlay) return;
    let live = true;
    const asked = JSON.parse(listKey) as [number, SessionQuery["filter"]];
    source.sessions({ at: null, gapMinutes: asked[0], filter: asked[1] }).then(
      (items) => {
        if (live) setSessions({ key: listKey, items });
      },
      () => {
        // The picker is a convenience: the review and its Previous / Next still work.
        if (live) setSessions({ key: listKey, items: [] });
      },
    );
    return () => {
      live = false;
    };
  }, [listKey, source, reloadToken, hiddenDuringPlay]);

  let body: ReactNode;
  if (hiddenDuringPlay) {
    body = <p className={styles.notice}>{r.hiddenDuringPlay}</p>;
  } else if (loaded.status === "error") {
    body = renderState("error", r.error(loaded.message));
  } else if (loaded.status === "loading") {
    body = renderState("loading", r.loading);
  } else {
    body = (
      <SessionReviewView
        review={loaded.review}
        deviations={loaded.deviations}
        deviationHands={loaded.deviationHands}
        deviationKind={loaded.source.kind}
        deviationLabel={loaded.source.label ?? null}
        deviationChoices={deviationChoices}
        deviationChoice={deviationSource.id}
        onDeviationSource={onDeviationSource}
        sessions={sessions?.key === listKey ? sessions.items : null}
        query={query}
        onQuery={onQuery}
        renderHandLink={renderHandLink}
        renderState={renderState}
        coverageAction={coverageAction}
        stale={loaded.key !== key}
      />
    );
  }

  return (
    <div className={styles.screen} aria-busy={!hiddenDuringPlay && (loaded.status === "loading" || (loaded.status === "ready" && loaded.key !== key))}>
      <header className={styles.top}>
        <Title className={styles.title}>{title}</Title>
        <p className={styles.intro}>{r.intro}</p>
      </header>
      {notice}
      {body}
    </div>
  );
}

export interface SessionReviewViewProps {
  review: SessionReview;
  deviations: readonly ReviewDecision[];
  /** Hands the deviation source named that the review does not carry. */
  deviationHands?: Readonly<Record<string, ReviewHand>>;
  /** Whose charts the deviations are from: Rail's, or the user's chart named `deviationLabel`. */
  deviationKind?: DeviationSource["kind"];
  deviationLabel?: string | null;
  deviationChoices?: ReadonlyArray<{ id: string; label: string }> | undefined;
  deviationChoice?: string | undefined;
  onDeviationSource?: ((id: string) => void) | undefined;
  /** The picker's sessions, newest first; null while they load. */
  sessions: readonly SessionListItem[] | null;
  query: SessionQuery;
  onQuery: (query: SessionQuery) => void;
  renderHandLink: (props: HandLinkProps) => ReactNode;
  renderState: (kind: "loading" | "empty" | "error", text: string) => ReactNode;
  coverageAction?: ReactNode;
  /** What is shown is the previous session's while the next one loads. */
  stale?: boolean;
  /** Hands shown per list. */
  cap?: number;
}

/** The loaded review: the picker, the summary and the lists. Pure (the tests render it). */
export function SessionReviewView({
  review,
  deviations,
  deviationHands,
  deviationKind = "shipped",
  deviationLabel = null,
  deviationChoices,
  deviationChoice,
  onDeviationSource,
  sessions,
  query,
  onQuery,
  renderHandLink,
  renderState,
  coverageAction,
  stale = false,
  cap = REVIEW_SHOWN,
}: SessionReviewViewProps) {
  const ui = useUiStrings();
  const r = ui.review;
  const locale = ui.intlLocale;
  const hands = useMemo(
    () => (deviationHands && Object.keys(deviationHands).length > 0 ? { ...deviationHands, ...review.hands } : review.hands),
    [review, deviationHands],
  );
  const sections = useMemo(
    () => selectWorthALook({ worst: review.worst, deviations, pots: review.pots, hands }, cap),
    [review, deviations, hands, cap],
  );
  const filtered = Object.values(query.filter).some((value) => (Array.isArray(value) ? value.length > 0 : value != null));
  const session = review.session;

  if (session === null) {
    return (
      <>
        {filtered ? <FilterLine query={query} onQuery={onQuery} /> : null}
        {renderState("empty", filtered ? r.noMatch : r.noHands)}
      </>
    );
  }

  const day = dateFormat(locale, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const time = dateFormat(locale, { hour: "2-digit", minute: "2-digit" });
  const missing = Math.max(0, review.coverage.hands - review.coverage.analysed);

  return (
    <div className={`${styles.body}${stale ? ` ${styles.stale}` : ""}`}>
      <Picker review={review} sessions={sessions} query={query} onQuery={onQuery} />
      {filtered ? <FilterLine query={query} onQuery={onQuery} /> : null}

      {review.ongoing ? (
        <p className={styles.notice} role="status">
          {r.ongoing.text(time.format(new Date(review.ongoing.startedAt)), time.format(new Date(review.ongoing.endedAt)))}{" "}
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => onQuery({ ...query, at: review.ongoing?.startedAt ?? null })}
          >
            {r.ongoing.reviewNow}
          </button>
        </p>
      ) : null}
      {!session.finished ? <p className={styles.notice}>{r.notFinished}</p> : null}

      <Summary review={review} />

      {missing > 0 ? (
        <p className={styles.notice}>
          {r.coverage.missing(missing, review.coverage.hands)} {coverageAction}
        </p>
      ) : null}
      {review.coverage.notAnalysed > 0 ? <p className={styles.muted}>{r.coverage.notAnalysed(review.coverage.notAnalysed)}</p> : null}

      {sections.map((section) => (
        <ListSection
          key={section.kind}
          section={section}
          own={section.kind === "deviations" && deviationKind === "own" ? (deviationLabel ?? "") : null}
          choice={
            section.kind === "deviations" && deviationChoices && deviationChoices.length > 1 && onDeviationSource ? (
              <label className={styles.pickerField}>
                <span className={styles.pickerLabel}>{r.deviationSource.label}</span>
                <select value={deviationChoice} onChange={(event) => onDeviationSource(event.target.value)}>
                  {deviationChoices.map((choice) => (
                    <option key={choice.id} value={choice.id}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null
          }
          graded={review.coverage.graded}
          dayTime={(iso) => (iso ? `${day.format(new Date(iso))} ${time.format(new Date(iso))}` : "—")}
          renderHandLink={(props) => renderHandLink({ ...props, sessionAt: session.startedAt })}
        />
      ))}
    </div>
  );
}

function FilterLine({ query, onQuery }: { query: SessionQuery; onQuery: (query: SessionQuery) => void }) {
  const r = useUiStrings().review;
  return (
    <p className={styles.muted}>
      {r.picker.filtered}{" "}
      <button type="button" className="btn btn--sm btn--ghost" onClick={() => onQuery({ ...query, at: null, filter: {} })}>
        {r.picker.clearFilter}
      </button>
    </p>
  );
}

function Picker({
  review,
  sessions,
  query,
  onQuery,
}: {
  review: SessionReview;
  sessions: readonly SessionListItem[] | null;
  query: SessionQuery;
  onQuery: (query: SessionQuery) => void;
}) {
  const ui = useUiStrings();
  const r = ui.review;
  const session = review.session;
  const day = dateFormat(ui.intlLocale, { weekday: "short", day: "numeric", month: "short" });
  const time = dateFormat(ui.intlLocale, { hour: "2-digit", minute: "2-digit" });
  if (!session) return null;
  const label = (item: { startedAt: string; endedAt: string; hands: number }) =>
    r.picker.option(
      day.format(new Date(item.startedAt)),
      time.format(new Date(item.startedAt)),
      time.format(new Date(item.endedAt)),
      item.hands,
    );
  const options = sessions ?? [];
  const listed = options.some((item) => item.startedAt === session.startedAt);
  const value = query.at === null ? "" : session.startedAt;

  return (
    <div className={styles.picker}>
      <label className={styles.pickerField}>
        <span className={styles.pickerLabel}>{r.picker.label}</span>
        <select
          value={value}
          onChange={(event) => onQuery({ ...query, at: event.target.value === "" ? null : event.target.value })}
        >
          <option value="">{r.picker.latest}</option>
          {listed || query.at === null ? null : <option value={session.startedAt}>{label(session)}</option>}
          {options.map((item) => (
            <option key={item.startedAt} value={item.startedAt}>
              {label(item)}
            </option>
          ))}
        </select>
      </label>
      <div className={styles.walk}>
        <button
          type="button"
          className="btn btn--sm"
          disabled={session.previousAt === null}
          onClick={() => onQuery({ ...query, at: session.previousAt })}
        >
          ← {r.picker.previous}
        </button>
        <button
          type="button"
          className="btn btn--sm"
          disabled={session.nextAt === null}
          onClick={() => onQuery({ ...query, at: session.nextAt })}
        >
          {r.picker.next} →
        </button>
      </div>
      <p className={styles.muted}>{r.picker.gap(review.gapMinutes)}</p>
    </div>
  );
}

function Summary({ review }: { review: SessionReview }) {
  const ui = useUiStrings();
  const r = ui.review;
  const locale = ui.intlLocale;
  const session = review.session;
  if (!session) return null;
  const day = dateFormat(locale, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const time = dateFormat(locale, { hour: "2-digit", minute: "2-digit" });
  const one = numberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: "exceptZero" });
  const unit =
    session.currency !== null && session.currencyMinorUnits !== null
      ? unitOf({ currency: session.currency, currencySymbol: session.currencySymbol ?? "", minorUnits: session.currencyMinorUnits })
      : null;
  const tone = (value: number | null) => (value === null || value === 0 ? "" : value > 0 ? styles.up : styles.down);
  const bb100 = bbPer100(session.netBbMilli, session.hands);

  return (
    <section className={styles.summary} aria-label={r.summary.label}>
      <dl className={styles.tiles}>
        <div className={`${styles.tile} ${styles.tileWide}`}>
          <dt>{r.summary.when}</dt>
          <dd className={styles.when}>
            {day.format(new Date(session.startedAt))}, {time.format(new Date(session.startedAt))}–
            {time.format(new Date(session.endedAt))}
          </dd>
        </div>
        <div className={styles.tile}>
          <dt>{r.summary.hands}</dt>
          <dd>{countIn(locale, session.hands)}</dd>
        </div>
        <div className={styles.tile}>
          <dt>{r.summary.duration}</dt>
          <dd>{r.summary.durationValue(minutesBetween(session.startedAt, session.endedAt))}</dd>
        </div>
        <div className={styles.tile}>
          <dt>{r.summary.tables}</dt>
          <dd>{countIn(locale, session.tables)}</dd>
        </div>
        {session.net !== null && unit ? (
          <div className={styles.tile}>
            <dt>{r.summary.result}</dt>
            <dd className={tone(session.net)}>{signedMoney(unit, session.net)}</dd>
          </div>
        ) : null}
        <div className={styles.tile}>
          <dt>{r.summary.netBb}</dt>
          <dd className={tone(session.netBbMilli)}>
            {session.netBbMilli === null ? "—" : bigBlindsIn(locale, session.netBbMilli)}
          </dd>
        </div>
        <div className={styles.tile}>
          <dt>{r.summary.bb100}</dt>
          <dd className={tone(bb100)}>{bb100 === null ? "—" : one.format(bb100)}</dd>
        </div>
        {session.allInHands > 0 && session.evNetBbMilli !== null ? (
          <div className={styles.tile}>
            <dt>{r.summary.evBb}</dt>
            <dd className={tone(session.evNetBbMilli)}>{bigBlindsIn(locale, session.evNetBbMilli)}</dd>
            <dd className={styles.tileNote}>{r.summary.evNote(session.allInHands)}</dd>
          </div>
        ) : null}
      </dl>
      {session.mixedUnitKind ? <p className={styles.warning}>{r.summary.mixedKind}</p> : null}
      {!session.mixedUnitKind && session.mixedCurrency ? <p className={styles.muted}>{r.summary.mixedCurrency}</p> : null}
    </section>
  );
}

function ListSection({
  section,
  own,
  choice,
  graded,
  dayTime,
  renderHandLink,
}: {
  section: ReviewSection;
  /** The deviations come from the user's own chart of this name. */
  own: string | null;
  /** The surface's choice of deviation source, over the list. */
  choice: ReactNode;
  graded: number;
  dayTime: (iso: string | null) => string;
  renderHandLink: (props: Omit<HandLinkProps, "sessionAt">) => ReactNode;
}) {
  const r = useUiStrings().review;
  const words = r.lists[section.kind];
  const id = `review-${section.kind}`;
  let empty: string | null = null;
  if (section.candidates === 0) {
    empty =
      section.kind !== "pots" && graded === 0
        ? (words as typeof r.lists.worst).emptyUnanalysed
        : own !== null
          ? r.deviationSource.empty(own)
          : words.empty;
  }
  return (
    <section className={styles.card} aria-labelledby={id}>
      <div className={styles.cardHead}>
        <h2 id={id} className={styles.cardTitle}>
          {words.heading}
        </h2>
        <p className={styles.muted}>{own !== null ? r.deviationSource.description(own) : words.description}</p>
        {choice}
      </div>
      {empty !== null ? <p className={styles.muted}>{empty}</p> : null}
      {section.items.length > 0 ? (
        <ol className={styles.list}>
          {section.items.map((item) => (
            <li key={item.handId}>
              <Row item={item} own={own !== null} dayTime={dayTime} renderHandLink={renderHandLink} />
            </li>
          ))}
        </ol>
      ) : null}
      {section.shownAbove > 0 ? <p className={styles.muted}>{r.lists.more(section.shownAbove)}</p> : null}
    </section>
  );
}

function GradeChip({ grade }: { grade: string | null }) {
  const r = useUiStrings().review;
  if (!grade || !GRADE_GLYPHS[grade]) return null;
  return (
    <span className={`${styles.grade} ${styles[`grade_${grade}`] ?? ""}`}>
      <span aria-hidden="true" className={styles.glyph}>
        {GRADE_GLYPHS[grade]}
      </span>
      {r.grades[grade] ?? grade}
    </span>
  );
}

function Row({
  item,
  own,
  dayTime,
  renderHandLink,
}: {
  item: ReviewItem;
  /** A deviation from the user's own chart (its words, not the shipped chart's). */
  own: boolean;
  dayTime: (iso: string | null) => string;
  renderHandLink: (props: Omit<HandLinkProps, "sessionAt">) => ReactNode;
}) {
  const ui = useUiStrings();
  const r = ui.review;
  const locale = ui.intlLocale;
  const hand = item.hand;
  const decision = item.decision;
  const one = numberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const percent = numberFormat(locale, { maximumFractionDigits: 1 });
  const when = dayTime(hand?.playedAt ?? null);
  const cards = hand && hand.heroCards.length > 0 ? hand.heroCards.join(" ") : r.row.noCards;
  const action = (name: string | null) => (name ? (r.actions[name] ?? name) : "");

  const detail: ReactNode[] = [];
  if (decision) {
    detail.push(
      <span key="took">{r.row.took(r.streets[decision.street] ?? decision.street, action(decision.action))}</span>,
    );
    if (decision.best && decision.best !== decision.action) {
      detail.push(
        <span key="best">{own ? r.deviationSource.best(action(decision.best)) : r.row.best(action(decision.best))}</span>,
      );
    }
    if (decision.street === "preflop" && decision.scenario && r.preflopSpots[decision.scenario]) {
      detail.push(<span key="spot">{r.preflopSpots[decision.scenario]}</span>);
    }
    if (item.kind === "deviations" && decision.chosenFreq !== null) {
      const value = percent.format(decision.chosenFreq * 100);
      detail.push(<span key="freq">{own ? r.deviationSource.freq(value) : r.row.chartFreq(value)}</span>);
    }
  }

  return renderHandLink({
    handId: item.handId,
    actionIndex: decision ? decision.actionIndex : null,
    label: r.row.open(cards, when),
    className: styles.row,
    children: (
      <>
        <span className={styles.rowHand}>
          {hand && hand.heroCards.length > 0 ? (
            <CardRow cards={hand.heroCards} size="xs" />
          ) : (
            <span className={styles.muted}>{r.row.noCards}</span>
          )}
          <span className={styles.rowMeta}>
            <span>{when}</span>
            <span>
              {[hand?.position, hand?.stakesLabel ?? null].filter((part): part is string => Boolean(part)).join(" · ")}
            </span>
          </span>
        </span>
        <span className={styles.rowWhy}>
          {decision ? (
            <>
              <span className={styles.rowLine}>
                <GradeChip grade={decision.grade} />
                {decision.evLossBb !== null && decision.evLossBb > 0 ? (
                  <span className={styles.loss}>{r.row.evLoss(one.format(decision.evLossBb))}</span>
                ) : null}
              </span>
              <span className={styles.rowDetail}>{detail}</span>
            </>
          ) : (
            <span className={styles.rowLine}>
              <strong>{r.row.pot(one.format(item.potBb ?? 0))}</strong>
            </span>
          )}
        </span>
        <span className={styles.rowResult}>
          {hand?.netBbMilli !== null && hand?.netBbMilli !== undefined ? (
            <span className={hand.netBbMilli > 0 ? styles.up : hand.netBbMilli < 0 ? styles.down : ""}>
              {r.row.result(bigBlindsIn(locale, hand.netBbMilli))}
            </span>
          ) : null}
          {hand?.evNetBbMilli !== null && hand?.evNetBbMilli !== undefined ? (
            <span className={styles.muted}>{r.row.ev(bigBlindsIn(locale, hand.evNetBbMilli))}</span>
          ) : null}
          {decision && item.potBb !== null ? <span className={styles.muted}>{r.row.pot(one.format(item.potBb))}</span> : null}
        </span>
        {item.badges.length > 0 ? (
          <span className={styles.badges}>
            {item.badges.map((badge) => (
              <span key={badge.kind} className={`${styles.badge} ${styles[`badge_${badge.kind}`] ?? ""}`}>
                {r.badges[badge.kind](badge.rank)}
              </span>
            ))}
          </span>
        ) : null}
      </>
    ),
  });
}
