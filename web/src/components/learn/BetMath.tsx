/**
 * The bet calculator, in three shapes:
 *
 * - **call** (`pot-odds`): the pot including the bet you face, the call, and
 *   your equity — the price, and what the call is worth;
 * - **defend** (`mdf`, `polar`): the pot before a bet and the bet — alpha, MDF,
 *   the caller's price and the polarised bluff share;
 * - **risk** (`alpha`, `steal`): the pot before your bet or raise, the chips it
 *   risks, and how often they fold — the break-even fold rate and the EV.
 *
 * Every number is `lib/learn/math.ts`, the same functions the tests pin.
 */

"use client";

import { useState } from "react";
import type { BetMathFocus } from "../../lib/learn/concepts";
import {
  alpha,
  bluffEv,
  bluffShare,
  callEv,
  mdf,
  potOddsRatio,
  requiredEquity,
  valuePerBluff,
} from "../../lib/learn/math";
import { useDict } from "../../lib/i18n/client";
import { ShareBar, Slider, Stat, Stats, evTone, useFormats } from "./controls";
import styles from "./learn.module.css";

interface BetMathProps {
  focus: BetMathFocus;
  pot: number;
  bet: number;
  share: number;
}

export function BetMath(props: BetMathProps) {
  if (props.focus === "pot-odds") return <CallMath {...props} />;
  if (props.focus === "mdf" || props.focus === "polar") return <DefendMath {...props} />;
  return <RiskMath {...props} />;
}

function CallMath({ pot: pot0, bet: call0, share }: BetMathProps) {
  const t = useDict().learn.widgets;
  const f = useFormats();
  const [pot, setPot] = useState(pot0);
  const [call, setCall] = useState(call0);
  const [equity, setEquity] = useState(share);
  const needed = requiredEquity(pot, call);
  const ev = callEv(pot, call, equity);
  const tone = evTone(ev);
  return (
    <div className={styles.calc}>
      <div className={styles.controls}>
        <Slider label={t.potIncludingBet} value={pot} min={1} max={Math.max(100, pot0 * 4)} step={0.5} onChange={setPot} format={f.bb} />
        <Slider label={t.toCall} value={call} min={0.5} max={Math.max(50, call0 * 4)} step={0.5} onChange={setCall} format={f.bb} />
        <Slider label={t.yourEquity} value={equity} min={0} max={1} step={0.005} onChange={setEquity} format={f.pct} />
      </div>
      <Stats>
        <Stat lead label={t.requiredEquity} value={f.pct(needed)} />
        <Stat label={t.potOdds} value={t.ratio(f.num(potOddsRatio(pot, call), 2))} />
        <Stat
          label={t.callEv}
          value={f.signedBb(ev)}
          tone={tone}
          note={tone === "good" ? t.evPositive : tone === "bad" ? t.evNegative : t.evZero}
        />
      </Stats>
      <ShareBar value={equity} marker={needed} tone={tone} />
    </div>
  );
}

function DefendMath({ focus, pot: pot0, bet: bet0 }: BetMathProps) {
  const t = useDict().learn.widgets;
  const f = useFormats();
  const [pot, setPot] = useState(pot0);
  // The bet is set as a share of the pot, which is how sizes are thought about.
  const [size, setSize] = useState(Math.round((bet0 / pot0) * 100) / 100);
  const bet = pot * size;
  const a = alpha(pot, bet);
  const m = mdf(pot, bet);
  const price = bluffShare(pot, bet);
  const polar = focus === "polar";
  return (
    <div className={styles.calc}>
      <div className={styles.controls}>
        <Slider label={t.potBeforeBet} value={pot} min={1} max={200} step={0.5} onChange={setPot} format={f.bb} />
        <Slider
          label={t.bet}
          value={size}
          min={0.1}
          max={3}
          step={0.05}
          onChange={setSize}
          format={(value) => `${t.ofPot(f.pct(value))} · ${f.bb(pot * value)}`}
        />
      </div>
      <Stats>
        {polar ? (
          <>
            <Stat lead label={t.bluffShare} value={f.pct(price)} />
            <Stat label={t.valuePerBluff} value={f.num(valuePerBluff(pot, bet), 2)} />
            <Stat label={t.mdf} value={f.pct(m)} />
            <Stat label={t.alpha} value={f.pct(a)} />
          </>
        ) : (
          <>
            <Stat lead label={t.mdf} value={f.pct(m)} />
            <Stat label={t.alpha} value={f.pct(a)} />
            <Stat label={t.callerPrice} value={f.pct(price)} />
          </>
        )}
      </Stats>
      <ShareBar value={polar ? price : m} />
    </div>
  );
}

function RiskMath({ focus, pot: pot0, bet: risk0, share }: BetMathProps) {
  const t = useDict().learn.widgets;
  const f = useFormats();
  const [pot, setPot] = useState(pot0);
  const [risk, setRisk] = useState(risk0);
  const [folds, setFolds] = useState(share);
  const breakEven = alpha(pot, risk);
  const ev = bluffEv(pot, risk, folds);
  const tone = evTone(ev);
  const steal = focus === "steal";
  return (
    <div className={styles.calc}>
      <div className={styles.controls}>
        <Slider
          label={steal ? t.blinds : t.potBeforeRaise}
          value={pot}
          min={steal ? 0.5 : 1}
          max={steal ? 20 : 200}
          step={steal ? 0.1 : 0.5}
          onChange={setPot}
          format={f.bb}
        />
        <Slider
          label={steal ? t.open : t.raise}
          value={risk}
          min={steal ? 1 : 0.5}
          max={steal ? 40 : 200}
          step={steal ? 0.1 : 0.5}
          onChange={setRisk}
          format={f.bb}
        />
        <Slider label={t.foldRate} value={folds} min={0} max={1} step={0.01} onChange={setFolds} format={f.pct} />
      </div>
      <Stats>
        <Stat lead label={t.alpha} value={f.pct(breakEven)} />
        <Stat
          label={t.bluffEv}
          value={f.signedBb(ev)}
          tone={tone}
          note={tone === "good" ? t.evPositive : tone === "bad" ? t.evNegative : t.evZero}
        />
      </Stats>
      <ShareBar value={folds} marker={breakEven} tone={tone} />
    </div>
  );
}
