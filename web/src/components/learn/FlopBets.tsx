/**
 * How often the preflop raiser bets the flop, by board group, over Rail's own
 * flop library (Learn L2, *flop bets by board type*). The rows are the
 * committed data (`lib/learn/data/flop-bets.json`, written from the library's
 * chunks and checked against the pilot's by the tests), averaged per group at
 * runtime (`groupRows`). Rail's solves only, labelled as such.
 */

"use client";

import { useMemo, useState } from "react";
import { useDict } from "../../lib/i18n/client";
import { FLOP_BET_SPOTS, groupRows, type FlopBetData, type FlopBetLine } from "../../lib/learn/flopBets";
import data from "../../lib/learn/data/flop-bets.json";
import { useFormats } from "./controls";
import "../../styles/stats.css";
import styles from "./learn.module.css";

const DATA = data as FlopBetData;

export function FlopBets({ line: initial }: { line?: string }) {
  const t = useDict().course.flopBets;
  const f = useFormats();
  const start = FLOP_BET_SPOTS.find((s) => s.line === initial)?.line ?? FLOP_BET_SPOTS[0].line;
  const [line, setLine] = useState<FlopBetLine>(start);
  const rows = useMemo(() => groupRows(DATA.lines[line] ?? []), [line]);
  const flops = (DATA.lines[line] ?? []).length;

  return (
    <div className={styles.calc}>
      <div className={styles.controls}>
        <label className="field">
          <span className="field__label">{t.line}</span>
          <select value={line} onChange={(event) => setLine(event.target.value as FlopBetLine)}>
            {FLOP_BET_SPOTS.map((s) => (
              <option key={s.line} value={s.line}>
                {t.lines[s.line] ?? s.line}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className={styles.results} aria-live="polite">
        <div className="stats-table-wrap">
          <table className="stats-table">
            <caption className={styles.caption}>{t.caption(flops)}</caption>
            <thead>
              <tr>
                <th scope="col">{t.group}</th>
                <th scope="col" className="num">
                  {t.flops}
                </th>
                <th scope="col" className="num">
                  {t.bet}
                </th>
                <th scope="col" className="num">
                  {t.big}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.group}>
                  <th scope="row">{t.groups[row.group] ?? row.group}</th>
                  <td className="num">{row.flops}</td>
                  <td className="num">{f.pct(row.bet)}</td>
                  <td className="num">{f.pct(row.big)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={styles.caption}>{t.source}</p>
      </div>
    </div>
  );
}
