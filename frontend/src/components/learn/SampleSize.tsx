/**
 * How far a stat over a number of chances can sit from the player's true
 * frequency (Learn L4, `reading-hud-stats`): the 95% interval's half-width,
 * the plausible range, and the chances the stat needs for ± 5 points. Plain
 * sampling arithmetic (`lib/learn/math.ts`), the same the course test
 * recomputes.
 */

"use client";

import { useState } from "react";
import { useDict } from "../../lib/i18n/client";
import { marginOfError, sampleNeeded } from "../../lib/learn/math";
import { ShareBar, Slider, Stat, Stats, useFormats } from "./controls";
import styles from "./learn.module.css";

export function SampleSize({ share = 0.3, count = 50 }: { share?: number; count?: number }) {
  const t = useDict().course.sampleSize;
  const f = useFormats();
  const [p, setP] = useState(share);
  const [n, setN] = useState(count);
  const margin = marginOfError(p, n);
  const low = Math.max(0, p - margin);
  const high = Math.min(1, p + margin);
  return (
    <div className={styles.calc}>
      <div className={styles.controls}>
        <Slider label={t.stat} value={p} min={0.05} max={0.95} step={0.01} onChange={setP} format={f.pct} />
        <Slider label={t.chances} value={n} min={5} max={2000} step={5} onChange={setN} format={(x) => t.count(f.num(x, 0))} />
      </div>
      <div className={styles.results}>
        <Stats>
          <Stat lead label={t.margin} value={`± ${f.pct(margin)}`} />
          <Stat label={t.range} value={`${f.pct(low)} – ${f.pct(high)}`} />
          <Stat label={t.needed} value={f.num(Math.ceil(sampleNeeded(p, 0.05)), 0)} />
        </Stats>
        <ShareBar value={high} marker={p} />
      </div>
    </div>
  );
}
