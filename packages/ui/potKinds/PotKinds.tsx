/**
 * The Analysis screen's Multiway and Bomb pots tabs (analysis/45, design
 * `ideas-potkinds` variant C), as views: each surface fetches and hands in
 * the data (`model.ts`). The other Analysis tabs read heads-up pots only;
 * these two read the rest, each under a closable note that says why Rail's
 * grades there are a rough guide (no solver covers them) and that results
 * are exact. Closed, the note leaves an "Approximate" chip that opens it
 * again; the choice is remembered per kind (this browser or app).
 */

import { useState, type ReactNode } from "react";

import { CardRow } from "../cards/PlayingCard";
import { useUiStrings } from "../i18n";
import { numberFormat } from "../stats/format";
import {
  BLUFF_NEEDS,
  BOMB_AGGRESSION_STUDY,
  MIN_CHANCES,
  type BetSize,
  type BombSummary,
  type MultiwaySummary,
  type PotKind,
  type PotKindDecision,
  type Rate,
} from "./model";
import styles from "./PotKinds.module.css";

const NOTE_KEY = (kind: PotKind) => `rail.analysis.potKindNote.${kind}`;

/** Number words in the reader's language. */
function useFormat() {
  const locale = useUiStrings().intlLocale;
  const int = numberFormat(locale, { maximumFractionDigits: 0 });
  const one = numberFormat(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  const two = numberFormat(locale, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  const signed = (x: number, f: Intl.NumberFormat = int) => (x > 0 ? `+${f.format(x)}` : x < 0 ? `−${f.format(-x)}` : f.format(0));
  const pct = (x: number) => `${int.format(Math.round(x * 100))}%`;
  return { int, one, two, signed, pct };
}

const pctOf = (r: Rate) => (r.n > 0 ? r.hits / r.n : 0);
const tone = (x: number) => (x > 0 ? styles.pos : x < 0 ? styles.neg : "");
const span = ([a, z]: [number, number]) => (a === z ? `${a}` : `${a}–${z}`);

function readClosed(kind: PotKind): boolean {
  try {
    return window.localStorage.getItem(NOTE_KEY(kind)) === "closed";
  } catch {
    return false;
  }
}

function writeClosed(kind: PotKind, closed: boolean): void {
  try {
    if (closed) window.localStorage.setItem(NOTE_KEY(kind), "closed");
    else window.localStorage.removeItem(NOTE_KEY(kind));
  } catch {
    // Not remembered: the note shows again next time.
  }
}

/** The closable note and, closed, the chip that opens it again. */
export function PotKindNote({ kind }: { kind: PotKind }) {
  const t = useUiStrings().potKinds;
  const [closed, setClosed] = useState(() => readClosed(kind));
  const set = (value: boolean) => {
    writeClosed(kind, value);
    setClosed(value);
  };
  if (closed) {
    return (
      <div>
        <button type="button" className={styles.chip} data-kind={kind} title={t.approximateTitle} onClick={() => set(false)}>
          ≈ {t.approximate}
        </button>
      </div>
    );
  }
  return (
    <div className={styles.note} data-kind={kind} role="note">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v5M12 8h.01" />
      </svg>
      <p className={styles.noteText}>{t.note[kind]}</p>
      <button type="button" className={styles.close} aria-label={t.close} onClick={() => set(true)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
}

function Figures({ hands, netBb, showdownBb, nonShowdownBb }: { hands: number; netBb: number; showdownBb: number; nonShowdownBb: number }) {
  const t = useUiStrings().potKinds.figures;
  const { int, one, signed } = useFormat();
  const per100 = hands > 0 ? (netBb / hands) * 100 : 0;
  return (
    <div className={styles.figures}>
      <div className={styles.figure}>
        <span className={styles.figureLabel}>{t.hands}</span>
        <span className={styles.figureValue}>{int.format(hands)}</span>
      </div>
      <div className={styles.figure}>
        <span className={styles.figureLabel}>
          <i className={`${styles.key} ${styles.keyTotal}`} />
          {t.result}
        </span>
        <span className={`${styles.figureValue} ${tone(per100)}`}>{t.perHundred(signed(per100, one))}</span>
        <span className={styles.figureSub}>{t.bb(signed(netBb))}</span>
      </div>
      <div className={styles.figure}>
        <span className={styles.figureLabel}>
          <i className={`${styles.key} ${styles.keyShowdown}`} />
          {t.showdown}
        </span>
        <span className={`${styles.figureValue} ${tone(showdownBb)}`}>{t.bb(signed(showdownBb))}</span>
      </div>
      <div className={styles.figure}>
        <span className={styles.figureLabel}>
          <i className={`${styles.key} ${styles.keyNonShowdown}`} />
          {t.nonShowdown}
        </span>
        <span className={`${styles.figureValue} ${tone(nonShowdownBb)}`}>{t.bb(signed(nonShowdownBb))}</span>
      </div>
    </div>
  );
}

function Box({ head, aside, children }: { head: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className={styles.box}>
      <div className={styles.boxHead}>
        <span>{head}</span>
        {aside ? <span>{aside}</span> : null}
      </div>
      {children}
    </section>
  );
}

/** The decisions graded Inaccurate or worse, most EV lost first; a row opens the hand's grades. */
function Worth({ rows, decisionHref }: { rows: PotKindDecision[] | null; decisionHref: (row: PotKindDecision) => string }) {
  const t = useUiStrings().potKinds;
  const { one, signed } = useFormat();
  if (rows === null) return null;
  return (
    <Box head={t.worth} aside={<span className={styles.dim}>{t.worthNote}</span>}>
      {rows.length === 0 ? (
        <p className={styles.muted}>{t.none}</p>
      ) : (
        <div className={styles.rows}>
          {rows.map((row) => (
            <a
              key={`${row.handKey}:${row.ord}`}
              className={styles.row}
              href={decisionHref(row)}
            >
              <span className={styles.dim}>{row.playedAt ? row.playedAt.slice(0, 10) : "—"}</span>
              <span>{row.position ?? "—"}</span>
              <span>{row.heroCards ? <CardRow cards={row.heroCards.split(" ")} size="xs" /> : "—"}</span>
              <span>
                {t.streets[row.street] ?? row.street}: {t.actions[row.action] ?? row.action}
                {row.players ? <span className={styles.dim}> · {t.playersAt(row.players)}</span> : null}
              </span>
              <span>
                <span className={styles.guide} data-grade={row.grade}>
                  ≈ {t.grades[row.grade] ?? row.grade}
                </span>
              </span>
              <span className={`${styles.neg}`} style={{ textAlign: "right" }}>
                {t.figures.approxBb(signed(-row.evLossBb, one))}
              </span>
            </a>
          ))}
        </div>
      )}
    </Box>
  );
}

/* ------------------------------------------------------------- bomb pots - */

/** The Bomb pots tab: the bomb pots' sums, Rail's study, the decisions worth a second look. */
export function BombPotsView({
  summary,
  worth,
  decisionHref,
}: {
  summary: BombSummary;
  worth: PotKindDecision[] | null;
  decisionHref: (row: PotKindDecision) => string;
}) {
  const t = useUiStrings().potKinds;
  const { int, two, signed, pct } = useFormat();
  const b = t.bomb;
  return (
    <div className={styles.page}>
      <PotKindNote kind="bomb" />
      <Figures hands={summary.hands} netBb={summary.netBb} showdownBb={summary.showdownBb} nonShowdownBb={summary.nonShowdownBb} />
      <div className={styles.grid2}>
        <Box head={b.byAnte}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{b.ante}</th>
                <th className={styles.r}>{t.figures.hands}</th>
                <th className={styles.r}>{t.figures.perHundredHead}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {summary.byAnte.map((row) => {
                const per100 = (row.netBb / row.hands) * 100;
                return (
                  <tr key={row.anteBb}>
                    <td>{b.anteBb(row.anteBb)}</td>
                    <td className={styles.r}>{int.format(row.hands)}</td>
                    <td className={`${styles.r} ${tone(per100)}`}>{signed(per100)}</td>
                    <td className={styles.dim}>{row.hands < 500 ? b.fewHands : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Box>
        <Box head={b.firstMove}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{b.move}</th>
                <th className={styles.r}>{t.figures.hands}</th>
                <th className={styles.r}>{b.perHand}</th>
                <th className={styles.r}>{b.inAll}</th>
              </tr>
            </thead>
            <tbody>
              {summary.byFirstMove.map((row) => (
                <tr key={row.move}>
                  <td>{b.moves[row.move] ?? row.move}</td>
                  <td className={styles.r}>{int.format(row.hands)}</td>
                  <td className={`${styles.r} ${tone(row.netBb)}`}>{signed(row.netBb / row.hands, two)}</td>
                  <td className={`${styles.r} ${tone(row.netBb)}`}>{signed(row.netBb)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Box>
      </div>

      <Box
        head={b.youAndPool}
        aside={
          <span className={styles.legend}>
            <span>
              <i className={styles.legendYou} />
              {b.you}
            </span>
            <span>
              <i className={styles.legendPool} />
              {b.pool}
            </span>
          </span>
        }
      >
        <div className={styles.compare}>
          {(Object.keys(summary.habits) as (keyof BombSummary["habits"])[]).map((key) => {
            const you = pctOf(summary.habits[key].hero);
            const pool = pctOf(summary.habits[key].pool);
            return [
              <span key={`${key}-l`}>{b.habits[key]}</span>,
              <div key={`${key}-t`} className={styles.track}>
                <i className={styles.trackFill} style={{ width: pct(you) }} />
                <b className={styles.trackMark} style={{ left: pct(pool) }} />
              </div>,
              <span key={`${key}-v`}>
                <b>{pct(you)}</b> <span className={styles.dim}>/ {pct(pool)}</span>
              </span>,
            ];
          })}
        </div>
      </Box>

      <Box
        head={b.foldThrough}
        aside={
          <span className={styles.legend}>
            <span>
              <i className={styles.legendPool} />
              {b.needed}
            </span>
          </span>
        }
      >
        {(Object.keys(summary.foldThrough) as BetSize[]).map((size) => {
          const r = summary.foldThrough[size];
          const got = pctOf(r);
          const need = BLUFF_NEEDS[size];
          const enough = r.n >= MIN_CHANCES;
          return (
            <div key={size} className={styles.ftRow}>
              <span>{b.sizes[size]}</span>
              <span className={styles.ftBar}>
                <i className={styles.ftFill} style={{ width: pct(got) }} />
                <em className={styles.ftNeed} style={{ left: pct(need) }} />
                <span className={styles.ftText}>
                  {pct(got)} <span className={styles.dim}>· {int.format(r.n)}</span>
                </span>
              </span>
              <span style={{ textAlign: "right" }}>
                <b className={enough ? (got >= need ? styles.pos : styles.neg) : styles.dim}>
                  {enough ? (got >= need ? b.works : b.loses) : b.tooFew}
                </b>{" "}
                <span className={styles.dim}>{b.needs(pct(need))}</span>
              </span>
            </div>
          );
        })}
      </Box>

      <Box head={b.aggression}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th />
              <th style={{ width: "50%" }}>
                <div className={styles.axis}>
                  <span>{t.figures.axisLow}</span>
                  <span>{b.axis}</span>
                  <span>{t.figures.axisHigh}</span>
                </div>
              </th>
              <th className={styles.r}>{b.percentile}</th>
            </tr>
          </thead>
          <tbody>
            {BOMB_AGGRESSION_STUDY.map((row) => {
              const at = (x: number) => `${Math.max(0, ((x - 40) / 60) * 100).toFixed(1)}%`;
              const wide = (a: number, z: number) => `${((Math.max(z - a, 1.5) / 60) * 100).toFixed(1)}%`;
              return (
                <tr key={row.line}>
                  <td>{b.lines[row.line]}</td>
                  <td>
                    <div className={styles.pct}>
                      <span className={styles.pctShown} style={{ left: at(row.shown[0]), width: wide(row.shown[0], row.shown[1]) }} />
                    </div>
                  </td>
                  <td className={styles.r}>{span(row.shown)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className={styles.muted}>{b.aggressionNote}</p>
        <p className={`${styles.muted} ${styles.dim}`}>{b.aggressionSource}</p>
      </Box>

      <Worth rows={worth} decisionHref={decisionHref} />
    </div>
  );
}

/* -------------------------------------------------------------- multiway - */

/** The Multiway tab: the multiway hands' sums, the multiway spots (`spots`), the decisions worth a second look. */
export function MultiwayView({
  summary,
  worth,
  spots,
  decisionHref,
}: {
  summary: MultiwaySummary;
  worth: PotKindDecision[] | null;
  /** The multiway spots ranked among themselves; none since analysis/46 grades no multiway flop. */
  spots?: ReactNode;
  decisionHref: (row: PotKindDecision) => string;
}) {
  const t = useUiStrings().potKinds;
  const { int, one, signed, pct } = useFormat();
  const m = t.mw;
  // analysis/46: a hand three or more saw the flop of has no postflop grade, so
  // the grade columns and boxes show only for analyses from before it.
  const graded = summary.graded > 0;
  const gradedShare = summary.decisions > 0 ? summary.graded / summary.decisions : 0;
  const gradeNames = ["perfect", "good", "inaccurate", "mistake", "blunder"];
  const decisionsAll = summary.byPlayers.reduce((sum, row) => sum + row.decisions, 0);
  return (
    <div className={styles.page}>
      <PotKindNote kind="mw" />
      <Figures
        hands={summary.hands}
        netBb={summary.netBbMilli / 1000}
        showdownBb={summary.showdownBbMilli / 1000}
        nonShowdownBb={summary.nonShowdownBbMilli / 1000}
      />
      <div className={graded ? styles.grid2 : undefined}>
        <Box head={m.byPlayers}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{m.players}</th>
                <th className={styles.r}>{m.decisions}</th>
                {graded ? (
                  <>
                    <th className={styles.r}>{m.graded}</th>
                    <th className={styles.r}>{m.off}</th>
                    <th className={styles.r}>{m.evLost}</th>
                  </>
                ) : (
                  <th className={styles.r}>{m.share}</th>
                )}
              </tr>
            </thead>
            <tbody>
              {summary.byPlayers.map((row) => (
                <tr key={row.players}>
                  <td>{m.playersN(row.players)}</td>
                  <td className={styles.r}>{int.format(row.decisions)}</td>
                  {graded ? (
                    <>
                      <td className={styles.r}>{int.format(row.graded)}</td>
                      <td className={styles.r}>{int.format(row.off)}</td>
                      <td className={`${styles.r} ${row.evLossBb > 0 ? styles.neg : ""}`}>{t.figures.approxBb(signed(-row.evLossBb, one))}</td>
                    </>
                  ) : (
                    <td className={styles.r}>{pct(decisionsAll > 0 ? row.decisions / decisionsAll : 0)}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </Box>
        {graded ? (
        <Box head={m.gradedHere}>
          <div className={styles.coverage}>
            <i className={styles.coverageGraded} style={{ width: pct(gradedShare) }} />
          </div>
          <div className={styles.compare} style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }}>
            <span>{m.gradedPart}</span>
            <b>{int.format(summary.graded)}</b>
            <span className={styles.dim}>{m.notGradedPart}</span>
            <span className={styles.dim}>{int.format(summary.decisions - summary.graded)}</span>
          </div>
          <div className={styles.legend}>
            {summary.grades.map((count, i) =>
              count > 0 ? (
                <span key={gradeNames[i]} className={styles.guide} data-grade={gradeNames[i]}>
                  ≈ {t.grades[gradeNames[i]]} {pct(count / Math.max(1, summary.graded))}
                </span>
              ) : null,
            )}
          </div>
        </Box>
        ) : null}
      </div>
      {graded ? spots : null}
      {graded ? <Worth rows={worth} decisionHref={decisionHref} /> : null}
    </div>
  );
}
