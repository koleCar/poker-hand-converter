/**
 * One hand's analysis in the app (R5.4): its decisions, each with the grade
 * the web's library gave it, the EV it cost, the reference's best action and
 * what the reference plays there. The stored row at the app's version when
 * there is one (`hand_analysis`), else the hand analysed now in a worker (and
 * left for the background run to store). Reached from Hands ("Analysis" in a
 * hand's panel) and from the session review's and the charts' lists, at the
 * decision they name. An analysis screen: hidden while a table is open (A10).
 *
 * Split view: the decisions on the left, the Solver on the right at the
 * decision picked (`SolverPanel`), the one the hand was opened at first.
 */
import { useEffect, useMemo, useState } from "react";
import { useDataSource } from "@rail/ui/data";
import type { PhfHand } from "@rail/ui/model/phf";

import { StateMessage } from "../../components/StateMessage";
import { useT } from "../../i18n";
import { liveNumberFormat } from "../../i18n/format";
import type { DecisionAnalysis, HandAnalysis as Analysis } from "../../analysis/library";
import { bestAction } from "../../analysis/rows";
import { handAnalysisOf } from "../../analysis/service";
import { go, screenHref } from "../../lib/router";
import { solverSpotOf } from "../../solver/spot";
import styles from "./Analysis.module.css";
import { IcmBlock } from "./IcmBlock";
import { SolverPanel } from "./SolverPanel";

export type Loaded =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error"; message: string }
  | { status: "ready"; analysis: Analysis; stored: boolean; /** (R5.5) When the hand was played: a players-left point is kept at it. */ playedAt?: string | null };

const TWO = liveNumberFormat({ minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ONE = liveNumberFormat({ minimumFractionDigits: 0, maximumFractionDigits: 1 });

const GLYPHS: Record<string, string> = { perfect: "★", good: "✓", inaccurate: "?!", mistake: "?", blunder: "??" };

export function HandAnalysis({
  handKey,
  actionIndex,
  back,
}: {
  handKey: string;
  actionIndex: number | null;
  /** The analysis view it came from (`view.ts`), for the Back link. */
  back: string | null;
}) {
  const data = useDataSource();
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const phf = (await data.hand(handKey)) as PhfHand | null;
        if (!phf) {
          if (live) setLoaded({ status: "missing" });
          return;
        }
        const result = await handAnalysisOf(handKey, phf as never);
        if (live) setLoaded(result ? { status: "ready", ...result, playedAt: phf.playedAt ?? null } : { status: "missing" });
      } catch (error) {
        if (live) setLoaded({ status: "error", message: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => {
      live = false;
    };
  }, [data, handKey]);

  return <HandAnalysisView handKey={handKey} actionIndex={actionIndex} back={back} loaded={loaded} />;
}

/** The hand's grades as loaded: the view the tests render. */
export function HandAnalysisView({
  handKey,
  actionIndex,
  back,
  loaded,
}: {
  handKey: string;
  actionIndex: number | null;
  back: string | null;
  loaded: Loaded;
}) {
  const h = useT().analysis.hand;
  const decisions = loaded.status === "ready" ? loaded.analysis.decisions : null;
  /** The decision the Solver shows: picked on the left; at first the one the hand was opened at, else the first the Solver has. */
  const [picked, setPicked] = useState<number | null>(null);
  const selected = useMemo(() => {
    if (!decisions) return null;
    const at = picked ?? actionIndex;
    return decisions.find((d) => d.actionIndex === at) ?? decisions.find((d) => solverSpotOf(decisions, d)) ?? decisions[0] ?? null;
  }, [decisions, picked, actionIndex]);
  const spot = useMemo(() => (decisions && selected ? solverSpotOf(decisions, selected) : null), [decisions, selected]);
  const bb = (value: number | null) => (value === null ? "–" : h.bb(TWO.format(value)));
  const percent = (value: number) => `${ONE.format(value * 100)} %`;

  let body;
  if (loaded.status === "loading") body = <StateMessage kind="loading">{h.loading}</StateMessage>;
  else if (loaded.status === "missing") body = <StateMessage kind="empty">{h.notFound}</StateMessage>;
  else if (loaded.status === "error") body = <StateMessage kind="error">{h.failed(loaded.message)}</StateMessage>;
  else {
    const a = loaded.analysis;
    const word = (map: Record<string, string>, key: string | null) => (key ? (map[key] ?? key) : "");
    body = (
      <div className={styles.split}>
        <div className={styles.splitDecisions}>
          {!loaded.stored && <p className={styles.note}>{h.notStored}</p>}
          <p className={styles.summary}>
            {a.status === "not-analysed"
              ? h.notAnalysed(a.reason ?? "")
              : a.grade
                ? h.summary(word(h.grades, a.grade), bb(a.evLoss))
                : h.noGrade}
          </p>
          <h2 className={styles.subheading}>{h.decisions}</h2>
          <ol className={`${styles.decisions} rail-stagger`}>
            {a.decisions.map((d) => (
              <DecisionRow
                key={d.order}
                decision={d}
                open={d.actionIndex === actionIndex}
                selected={d === selected}
                onSelect={() => setPicked(d.actionIndex)}
                bb={bb}
                percent={percent}
                word={word}
                playedAt={loaded.playedAt ?? null}
              />
            ))}
          </ol>
        </div>
        <SolverPanel spot={spot} />
      </div>
    );
  }

  return (
    <section className={`${styles.hand} ${styles.handWide}`} aria-labelledby="hand-analysis-title">
      <div className={styles.handHead}>
        <h1 id="hand-analysis-title" className={styles.title}>
          {h.title}
        </h1>
        <div className={styles.links}>
          {back && (
            <a className={styles.link} href={screenHref("analysis", back)}>
              {h.backToList}
            </a>
          )}
          <button type="button" className={styles.link} onClick={() => go("hands", handKey)}>
            {h.back}
          </button>
        </div>
      </div>
      {body}
    </section>
  );
}

function DecisionRow({
  decision: d,
  open,
  selected,
  onSelect,
  bb,
  percent,
  word,
  playedAt,
}: {
  decision: DecisionAnalysis;
  open: boolean;
  /** Shown in the Solver beside the list. */
  selected: boolean;
  onSelect: () => void;
  playedAt: string | null;
  bb: (value: number | null) => string;
  percent: (value: number) => string;
  word: (map: Record<string, string>, key: string | null) => string;
}) {
  const t = useT();
  const h = t.analysis.hand;
  const best = bestAction(d.options);
  return (
    <li
      className={[styles.decision, open ? styles.focused : "", selected ? styles.selected : ""].filter(Boolean).join(" ")}
      data-action-index={d.actionIndex}
    >
      <button type="button" className={styles.decisionHead} aria-pressed={selected} title={h.solver.pick} onClick={onSelect}>
        <span className={styles.street}>{word(h.streets, d.street)}</span>
        <span>
          <span className={styles.muted}>{h.action} </span>
          {word(h.actions, d.action)}
        </span>
        {best && (
          <span>
            <span className={styles.muted}>{h.best} </span>
            {word(h.actions, best)}
          </span>
        )}
        {d.status === "not-analysed" ? (
          <span className={styles.muted}>{h.skipped(d.reason ?? "")}</span>
        ) : d.grade ? (
          <span className={`${styles.grade} ${styles[`grade-${d.grade}`] ?? ""}`}>
            <span aria-hidden="true">{GLYPHS[d.grade] ?? ""}</span> {word(h.grades, d.grade)}
          </span>
        ) : (
          <span className={styles.muted}>{h.ungraded}</span>
        )}
        {d.grade && d.evLoss !== null && (
          <span>
            <span className={styles.muted}>{h.evLoss} </span>
            {bb(d.evLoss)}
          </span>
        )}
        <span className={styles.muted}>
          {h.source}: {word(h.sources, d.source)}
        </span>
        {d.flags.length > 0 && <span className={styles.muted}>{h.notes(d.flags.length)}</span>}
      </button>
      {d.options.length > 0 && (
        <details className={styles.options} open={open}>
          <summary>{h.options}</summary>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{h.option}</th>
                <th scope="col">{h.frequency}</th>
                <th scope="col">{h.ev}</th>
              </tr>
            </thead>
            <tbody>
              {d.options.map((o, i) => (
                <tr key={i} className={i === d.chosen ? styles.chosen : undefined}>
                  <td>{word(h.actions, o.action)}</td>
                  <td>{percent(o.freq)}</td>
                  <td>{bb(o.ev)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      {d.facts.icm && (
        <details className={styles.options} open={open}>
          <summary>{h.icm.heading}</summary>
          <IcmBlock decision={d} playedAt={playedAt} />
        </details>
      )}
    </li>
  );
}
