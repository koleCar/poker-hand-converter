/**
 * Your own pool, on an exploit lesson (Learn L4, the opponents-panel tie-in).
 *
 * Reads the opponents panel's rows (`stats_opponents`, an invoker function
 * under RLS: only the learner's own statistics) and sums them into the
 * learner's pool (`lib/learn/pool.ts`): each stat the lesson is about, with
 * the chances it had, its 95% interval, and whether that is enough to read
 * anything into. Where the numbers clear a line plain arithmetic draws (folds
 * to a flop c-bet against what a bluff of a size needs), it points at the
 * lesson and the lab preset for it. Signed out, without a database, or
 * without opponent statistics, it says so instead.
 */

"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { fetchStatsOpponents, isDatabaseConfigured } from "../../../lib/db";
import { useDict } from "../../../lib/i18n/client";
import type { PoolTopic } from "../../../lib/learn/course";
import { poolOf, poolReads, POOL_TOPIC_STATS, type Pool } from "../../../lib/learn/pool";
import { paths } from "../../../lib/routes";
import { useFormats } from "../controls";
import { useLearn } from "./LearnStore";
import styles from "./course.module.css";

/** Opponents summed at most (the report's own cap, biggest samples first). */
const MAX_OPPONENTS = 200;

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "done"; pool: Pool; opaque: number; capped: boolean };

export function PoolTendencies({ topic }: { topic: PoolTopic }) {
  const en = useDict();
  const t = en.course.pool;
  const f = useFormats();
  const store = useLearn();
  const signedIn = store.mode === "account";
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    fetchStatsOpponents({ minHands: 1 }, "", MAX_OPPONENTS).then(
      (report) => {
        if (!live) return;
        const rows = report.rows.map((row) => ({ counters: row.counters as unknown as Record<string, number> }));
        setState({ kind: "done", pool: poolOf(rows), opaque: report.opaqueRows, capped: report.rows.length >= MAX_OPPONENTS });
      },
      (error: unknown) => {
        if (live) setState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [signedIn]);

  let body: ReactNode;
  if (!isDatabaseConfigured) body = <p className={styles.muted}>{t.noDatabase}</p>;
  else if (store.mode === "loading") body = null;
  else if (!signedIn) body = <p className={styles.muted}>{t.signIn}</p>;
  else if (state.kind === "loading") body = <p className={styles.muted} role="status">{t.loading}</p>;
  else if (state.kind === "error") body = <p className="notice notice--warn">{t.failed(state.message)}</p>;
  else if (state.pool.players === 0) {
    body = (
      <>
        <p>{t.none}</p>
        {state.opaque > 0 ? <p className={styles.muted}>{t.opaque(f.num(state.opaque, 0))}</p> : null}
        <p>
          <Link href={paths.stats()}>{en.nav.stats}</Link>
        </p>
      </>
    );
  } else {
    const { pool } = state;
    const reads = poolReads(pool).filter((read) => topic === "all" || POOL_TOPIC_STATS[topic].includes(read.stat));
    body = (
      <>
        <p className={styles.muted}>
          {t.summary(f.num(pool.players, 0), f.num(pool.hands, 0))} {state.capped ? t.capped(f.num(MAX_OPPONENTS, 0)) : ""}
          {state.opaque > 0 ? ` ${t.opaque(f.num(state.opaque, 0))}` : ""}
        </p>
        <div className={styles.tableWrap}>
          <table className={styles.optionTable}>
            <tbody>
              {POOL_TOPIC_STATS[topic].map((id) => {
                const stat = pool.stats[id];
                return (
                  <tr key={id}>
                    <th scope="row">{t.stats[id]}</th>
                    <td>
                      {stat.value === null || stat.margin === null
                        ? t.noChances
                        : stat.level === "thin"
                          ? `${t.levels.thin} (${t.value(f.pct(stat.value), f.pct(stat.margin), f.num(stat.chances, 0))})`
                          : `${t.value(f.pct(stat.value), f.pct(stat.margin), f.num(stat.chances, 0))} · ${t.levels[stat.level]}`}
                    </td>
                    <td className={styles.muted}>{stat.neededForSettled !== null && stat.level !== "settled" ? t.needed(f.num(stat.neededForSettled, 0)) : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {reads.length > 0 ? (
          reads.map((read) => (
            <p key={read.stat}>
              {t.read[read.direction](t.stats[read.stat], f.pct(read.size), f.pct(read.needs))}{" "}
              <Link href={`${paths.lesson(read.lesson)}#${read.lesson}-practice`}>{t.lessonLink(en.course.titles[read.lesson])}</Link> ·{" "}
              {en.course.lab.presets[read.preset]}
            </p>
          ))
        ) : (
          <p className={styles.muted}>{t.noRead}</p>
        )}
      </>
    );
  }

  return (
    <div className={styles.pool}>
      <p>{t.intro}</p>
      {body}
    </div>
  );
}
