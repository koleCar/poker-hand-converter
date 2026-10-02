/**
 * The one-formula calculators: SPR and geometric sizing, the river
 * bluff-catcher, the thin value bet, and the grade explorer that runs Rail's
 * own `grade()` on numbers the reader sets.
 */

"use client";

import { useState } from "react";
import { grade } from "../../lib/analysis/grading";
import type { OptionAnalysis } from "../../lib/analysis/types";
import { useDict } from "../../lib/i18n/client";
import { bluffCatcherEv, bluffShare, geometricBet, potSizedBets, spr, valueBetGain } from "../../lib/learn/math";
import { ShareBar, Slider, Stat, Stats, evTone, useFormats } from "./controls";
import styles from "./learn.module.css";

/* -------------------------------------------------------------------- SPR - */

export function SprCalculator({ pot: pot0, stack: stack0 }: { pot: number; stack: number }) {
  const t = useDict().learn.widgets;
  const f = useFormats();
  const [pot, setPot] = useState(pot0);
  const [stack, setStack] = useState(stack0);
  const [streets, setStreets] = useState(3);
  const ratio = spr(stack, pot);
  const size = geometricBet(pot, stack, streets);
  return (
    <div className={styles.calc}>
      <div className={styles.controls}>
        <Slider label={t.pot} value={pot} min={1} max={150} step={0.5} onChange={setPot} format={f.bb} />
        <Slider label={t.spr.stack} value={stack} min={0} max={300} step={0.5} onChange={setStack} format={f.bb} />
        <Slider
          label={t.spr.streets}
          value={streets}
          min={1}
          max={3}
          step={1}
          onChange={setStreets}
          format={t.spr.streetCount}
        />
      </div>
      <Stats>
        <Stat lead label={t.spr.spr} value={f.num(ratio, 1)} />
        <Stat label={t.spr.geometric} value={`${t.ofPot(f.pct(size))} · ${f.bb(pot * size)}`} />
        <Stat label={t.spr.potBets} value={f.num(potSizedBets(pot, stack), 1)} />
      </Stats>
    </div>
  );
}

/* --------------------------------------------------------- bluff-catcher - */

export function BluffCatcher({ pot: pot0, bet: bet0, share }: { pot: number; bet: number; share: number }) {
  const t = useDict().learn.widgets;
  const f = useFormats();
  const [pot, setPot] = useState(pot0);
  const [bet, setBet] = useState(bet0);
  const [bluffs, setBluffs] = useState(share);
  const indifferent = bluffShare(pot, bet);
  const ev = bluffCatcherEv(pot, bet, bluffs);
  const tone = evTone(ev);
  return (
    <div className={styles.calc}>
      <div className={styles.controls}>
        <Slider label={t.potBeforeBet} value={pot} min={1} max={200} step={0.5} onChange={setPot} format={f.bb} />
        <Slider label={t.bet} value={bet} min={0.5} max={400} step={0.5} onChange={setBet} format={f.bb} />
        <Slider label={t.bluffCatcher.bluffs} value={bluffs} min={0} max={1} step={0.01} onChange={setBluffs} format={f.pct} />
      </div>
      <Stats>
        <Stat lead label={t.bluffCatcher.indifferent} value={f.pct(indifferent)} />
        <Stat
          label={t.bluffCatcher.ev}
          value={f.signedBb(ev)}
          tone={tone}
          note={t.bluffCatcher.verdict[tone === "good" ? "call" : tone === "bad" ? "fold" : "either"]}
        />
      </Stats>
      <ShareBar value={bluffs} marker={indifferent} tone={tone} />
    </div>
  );
}

/* ------------------------------------------------------------- value bet - */

export function ValueBet({ pot: pot0, bet: bet0, share }: { pot: number; bet: number; share: number }) {
  const t = useDict().learn.widgets;
  const f = useFormats();
  const [bet, setBet] = useState(bet0);
  const [callRate, setCallRate] = useState(share);
  const [beat, setBeat] = useState(0.6);
  const gain = valueBetGain(bet, callRate, beat);
  const tone = evTone(gain);
  return (
    <div className={styles.calc}>
      <div className={styles.controls}>
        <Slider
          label={t.bet}
          value={bet}
          min={0.5}
          max={pot0 * 2}
          step={0.5}
          onChange={setBet}
          format={(value) => `${f.bb(value)} · ${t.ofPot(f.pct(value / pot0))}`}
        />
        <Slider label={t.valueBet.callRate} value={callRate} min={0} max={1} step={0.01} onChange={setCallRate} format={f.pct} />
        <Slider label={t.valueBet.beatShare} value={beat} min={0} max={1} step={0.01} onChange={setBeat} format={f.pct} />
      </div>
      <Stats>
        <Stat
          lead
          label={t.valueBet.gain}
          value={f.signedBb(gain)}
          tone={tone}
          note={t.valueBet.verdict[tone === "good" ? "bet" : tone === "bad" ? "check" : "either"]}
        />
      </Stats>
      <ShareBar value={beat} marker={0.5} tone={tone} />
    </div>
  );
}

/* --------------------------------------------------------------- grading - */

const OPTIONS = ["fold", "call", "raise"] as const;
type Option = (typeof OPTIONS)[number];

/**
 * Rail's grading, live. Fold always has EV 0 and takes whatever frequency the
 * other two leave; the reader sets call and raise. The grade is `grade()`
 * itself, so the explorer cannot drift from what the analysis does.
 */
export function GradeExplorer() {
  const en = useDict();
  const t = en.learn.widgets.grading;
  const f = useFormats();
  const [pot, setPot] = useState(10);
  const [callFreq, setCallFreq] = useState(0.52);
  const [raiseFreq, setRaiseFreq] = useState(0.48);
  const [callEv, setCallEv] = useState(1.2);
  const [raiseEv, setRaiseEv] = useState(1.17);
  const [chosen, setChosen] = useState<Option>("raise");

  const raise = Math.min(raiseFreq, 1 - callFreq);
  const fold = Math.max(0, 1 - callFreq - raise);
  const options: OptionAnalysis[] = [
    { action: "fold", freq: fold, ev: 0 },
    { action: "call", freq: callFreq, ev: callEv },
    { action: "raise", freq: raise, ev: raiseEv },
  ];
  const result = grade({ options, chosen: OPTIONS.indexOf(chosen), pot });
  const label: Record<Option, string> = { fold: t.fold, call: t.call, raise: t.raise };

  return (
    <div className={styles.calc}>
      <div className={styles.controls}>
        <Slider label={t.pot} value={pot} min={1} max={100} step={0.5} onChange={setPot} format={f.bb} />
        <Slider label={t.freqLabel(t.call)} value={callFreq} min={0} max={1} step={0.01} onChange={setCallFreq} format={f.pct} />
        <Slider
          label={t.freqLabel(t.raise)}
          value={raise}
          min={0}
          max={1}
          step={0.01}
          onChange={(value) => setRaiseFreq(Math.min(value, 1 - callFreq))}
          format={f.pct}
          hint={`${t.foldRest}: ${f.pct(fold)}`}
        />
        <Slider label={t.evLabel(t.call)} value={callEv} min={-5} max={5} step={0.01} onChange={setCallEv} format={f.signedBb} />
        <Slider label={t.evLabel(t.raise)} value={raiseEv} min={-5} max={5} step={0.01} onChange={setRaiseEv} format={f.signedBb} />
        <fieldset className={styles.radios}>
          <legend>{t.chosen}</legend>
          {OPTIONS.map((option) => (
            <label key={option}>
              <input type="radio" name="grade-chosen" value={option} checked={chosen === option} onChange={() => setChosen(option)} />
              {label[option]}
            </label>
          ))}
        </fieldset>
      </div>
      <Stats>
        <div className={`${styles.stat} ${styles.statLead}`}>
          <dt>{t.grade}</dt>
          <dd className={styles[`grade-${result.grade}`]}>{en.analysis.grades[result.grade]}</dd>
        </div>
        <Stat label={t.evLoss} value={`${f.bb(result.evLoss)} · ${f.pct(result.evLossPot)} ${t.evLossPot}`} />
        <Stat label={t.score} value={f.num(result.score, 0)} />
      </Stats>
    </div>
  );
}
