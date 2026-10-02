/**
 * The common bet sizes against the three numbers that follow from them —
 * alpha, MDF and the caller's price (which is also the bluff share of a
 * polarised river bet). Computed, not typed in: `lib/learn/math.ts`.
 * Server-rendered; the caller passes the strings and the `Intl` locale.
 */

import { alpha, bluffShare, mdf } from "../../lib/learn/math";
import type { Dict } from "../../lib/i18n/types";
import "../../styles/stats.css";
import styles from "./learn.module.css";

const SIZES = [0.25, 0.33, 0.5, 0.75, 1, 1.5, 2] as const;

export function SizingTable({ t, intl }: { t: Dict["learn"]["widgets"]["sizingTable"]; intl: string }) {
  const pct = new Intl.NumberFormat(intl, { style: "percent", maximumFractionDigits: 1 });
  return (
    <div className="stats-table-wrap">
      <table className="stats-table">
        <caption className={styles.caption}>{t.caption}</caption>
        <thead>
          <tr>
            <th scope="col">{t.size}</th>
            <th scope="col" className="num">
              {t.alpha}
            </th>
            <th scope="col" className="num">
              {t.mdf}
            </th>
            <th scope="col" className="num">
              {t.price}
            </th>
          </tr>
        </thead>
        <tbody>
          {SIZES.map((size) => (
            <tr key={size}>
              <th scope="row">{pct.format(size)}</th>
              <td className="num">{pct.format(alpha(1, size))}</td>
              <td className="num">{pct.format(mdf(1, size))}</td>
              <td className="num">{pct.format(bluffShare(1, size))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
