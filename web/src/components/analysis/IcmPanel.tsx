/**
 * A tournament decision's ICM panel (R5.5c), under the options of a
 * push/fold grade (`source: "icm"`): what the grade was measured in and why,
 * the stacks, the payouts and players left it used (each with where it came
 * from), the hero's prize equity - and its money, when the prize pool is
 * known - after each option, the equilibrium's push and call ranges, and the
 * hero's bubble factor and risk premium against each player. Everything is
 * read from `facts.icm`: nothing is computed here.
 *
 * The owner (not a shared hand) can give the tournament's payouts, field and
 * players left (`TournamentSettingsForm`): saving them sends the
 * tournament's hands back to the analysis queue, so the next run grades them
 * with the settings.
 */

"use client";

import { useEffect, useState } from "react";
import type { DecisionAnalysis, IcmFacts } from "../../lib/analysis/types";
import { settingsProblem, type TournamentKind, type TournamentSettings } from "../../lib/analysis/tournament";
import { deleteTournamentSettings, fetchTournamentSettings, saveTournamentSettings } from "../../lib/db/tournamentSettings";
import { useDict } from "../../lib/i18n/client";
import type { PhfHand } from "../../lib/phf/types";
import { useIntlLocale } from "../stats/format";
import styles from "./analysis.module.css";
import icmStyles from "./icm.module.css";

/** The prize pool's share as money in the buy-in's unit, or null without a pool. */
function money(hand: PhfHand | undefined, icm: IcmFacts, share: number, locale: string): string | null {
  const unit = hand?.tournament?.buyInUnit;
  if (!icm.prizePool || !unit || icm.model !== "icm") return null;
  const value = (share * icm.prizePool.amount) / 10 ** unit.minorUnits;
  const digits = unit.minorUnits > 0 ? 2 : 0;
  const text = value.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return unit.symbol ? `${unit.symbol}${text}` : `${text} ${unit.code}`;
}

export function IcmPanel({ decision, hand, readOnly = false }: { decision: DecisionAnalysis; hand?: PhfHand; readOnly?: boolean }) {
  const dict = useDict();
  const t = dict.analysis.icm;
  const s = dict.analysis.sheet;
  const locale = useIntlLocale();
  const icm = decision.facts.icm;
  if (!icm) return null;
  const pct = (value: number, digits = 1) => `${(value * 100).toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
  const num = (value: number, digits = 2) => value.toLocaleString(locale, { minimumFractionDigits: 0, maximumFractionDigits: digits });
  const chips = icm.model === "chips";
  const optionNames = [t.fold, icm.scenario === "push" ? t.push : t.call];
  const startMoney = money(hand, icm, icm.equity.start, locale);
  const pusher = icm.scenario === "push" ? t.you : (icm.pusher ?? "?");

  return (
    <section id="icm-panel" className={styles.section} aria-label={t.heading}>
      <h3 className={styles.sectionTitle}>{t.heading}</h3>
      <p className={styles.hint}>
        <strong>{chips ? t.modelChips : t.modelIcm}</strong>
        {chips && icm.chipsReason ? ` - ${t.chipsReasons[icm.chipsReason] ?? icm.chipsReason}` : null}
      </p>

      <dl className={styles.facts}>
        <div>
          <dt>{t.stacks}</dt>
          <dd>
            <ul className={icmStyles.stacks}>
              {icm.stacks.map((stack) => (
                <li key={stack.seat} className={stack.hero ? icmStyles.hero : undefined}>
                  <span>{stack.hero ? t.you : (stack.position ?? `#${stack.seat}`)}</span> <span>{t.bbs(num(stack.stackBb, 1))}</span>
                </li>
              ))}
            </ul>
            {icm.others ? <span className={styles.hint}>{t.others(icm.others.count, t.bbs(num(icm.others.stackBb, 1)))}</span> : null}
          </dd>
        </div>
        {icm.payouts ? (
          <div>
            <dt>{t.payouts}</dt>
            <dd>
              {icm.payouts
                .slice(0, 9)
                .map((p) => num(p, 1))
                .join(" / ")}
              {icm.payouts.length > 9 ? " …" : ""} % <span className={styles.hint}>({t.sources[icm.payoutsSource ?? ""] ?? ""})</span>
            </dd>
          </div>
        ) : null}
        <div>
          <dt>{t.playersLeft}</dt>
          <dd>
            {icm.playersLeft ?? "?"}
            {icm.playersLeftSource ? <span className={styles.hint}> ({t.sources[icm.playersLeftSource]})</span> : null}
            <span className={styles.hint}> · {t.kinds[icm.kind] ?? icm.kind} ({t.kindSources[icm.kindSource]})</span>
          </dd>
        </div>
        {!chips ? (
          <div>
            <dt>{t.start}</dt>
            <dd>
              {pct(icm.equity.start)}
              {startMoney ? ` · ${startMoney}` : ""} <span className={styles.hint}>· {t.bbValue(icm.bbValue)}</span>
            </dd>
          </div>
        ) : null}
      </dl>

      <div className="stats-table-wrap">
        <table className={`stats-table ${styles.options}`}>
          <caption className={icmStyles.caption}>{t.options}</caption>
          <thead>
            <tr>
              <th scope="col">{s.colAction}</th>
              <th scope="col" className="num">
                {chips ? t.equityChips : t.equity}
              </th>
              <th scope="col" className="num">
                {t.evBb}
              </th>
            </tr>
          </thead>
          <tbody>
            {decision.options.map((option, index) => {
              const share = icm.equity.options[index] ?? 0;
              const cash = money(hand, icm, share, locale);
              return (
                <tr key={index} className={index === decision.chosen ? styles.chosenRow : undefined}>
                  <th scope="row">{optionNames[index] ?? option.action}</th>
                  <td className="num">
                    {pct(share, 2)}
                    {cash ? <span className={styles.hint}> · {cash}</span> : null}
                  </td>
                  <td className="num">{option.ev > 0 ? "+" : ""}{num(option.ev)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className={styles.hint}>{t.pushRange(pusher, icm.pushShare)}</p>
      <div className="stats-table-wrap">
        <table className={`stats-table ${styles.options}`}>
          <thead>
            <tr>
              <th scope="col">{t.player}</th>
              <th scope="col" className="num">
                {t.call}
              </th>
              <th scope="col" className="num" title={t.bfHint}>
                {t.bubbleFactor}
              </th>
              <th scope="col" className="num" title={t.rpHint}>
                {t.riskPremium}
              </th>
            </tr>
          </thead>
          <tbody>
            {icm.players.map((player) => {
              const isHero = icm.stacks.some((stack) => stack.hero && stack.seat === player.seat);
              return (
                <tr key={player.seat}>
                  <th scope="row">{isHero ? t.you : (player.position ?? `#${player.seat}`)}</th>
                  <td className="num">{pct(player.callShare, 0)}</td>
                  <td className="num">{player.bubbleFactor === null ? "-" : num(player.bubbleFactor)}</td>
                  <td className="num">{player.riskPremium === null ? "-" : pct(player.riskPremium)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className={styles.hint}>
        {t.bfHint}. {t.rpHint}.
        {icm.icmError !== null ? ` ${t.error(icm.icmError)}.` : ""} {t.gap(t.bbs(num(icm.gapBb, 3)))}.
      </p>

      {!readOnly && icm.key ? <TournamentSettingsForm tournamentKey={icm.key} playedAt={hand?.playedAt ?? null} icm={icm} /> : null}
    </section>
  );
}

const KINDS: readonly TournamentKind[] = ["sng", "spin", "mtt"];

/** "50, 30, 20" -> [50, 30, 20]; null when it is not a list of numbers. */
function parsePayouts(text: string): number[] | null {
  const parts = text
    .split(/[\s,;/]+/)
    .map((part) => part.replace(/%$/, "").replace(",", "."))
    .filter(Boolean);
  if (parts.length === 0) return null;
  const values = parts.map(Number);
  return values.every((v) => Number.isFinite(v)) ? values : null;
}

/** The owner's payouts, field and players left for one tournament. */
function TournamentSettingsForm({ tournamentKey, playedAt, icm }: { tournamentKey: string; playedAt: string | null; icm: IcmFacts }) {
  const dict = useDict();
  const t = dict.analysis.icm;
  const f = dict.analysis.icmForm;
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<TournamentSettings | null>(null);
  const [kind, setKind] = useState<string>("");
  const [payouts, setPayouts] = useState("");
  const [entrants, setEntrants] = useState("");
  const [startingStack, setStartingStack] = useState("");
  const [left, setLeft] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    fetchTournamentSettings()
      .then((all) => {
        if (!live) return;
        const mine = all.get(tournamentKey) ?? null;
        setSaved(mine);
        setKind(mine?.kind ?? "");
        setPayouts((mine?.payouts ?? icm.payouts ?? []).map((p) => String(Math.round(p * 100) / 100)).join(", "));
        setEntrants(mine?.entrants ? String(mine.entrants) : icm.entrants ? String(icm.entrants) : "");
        setStartingStack(mine?.startingStack ? String(mine.startingStack) : "");
        setLeft(icm.playersLeft !== null ? String(icm.playersLeft) : "");
      })
      .catch((error: unknown) => {
        if (live) setMessage(error instanceof Error ? error.message : String(error));
      });
    return () => {
      live = false;
    };
  }, [open, tournamentKey, icm]);

  const save = async () => {
    const next: TournamentSettings = {};
    if (kind) next.kind = kind as TournamentKind;
    if (payouts.trim()) {
      const parsed = parsePayouts(payouts);
      if (!parsed) {
        setMessage(f.problems.payouts);
        return;
      }
      next.payouts = parsed;
    }
    if (entrants.trim()) next.entrants = Number(entrants);
    if (startingStack.trim()) next.startingStack = Number(startingStack);
    // Players left: a point at this hand's time, kept with the earlier ones.
    const points = (saved?.playersLeft ?? []).filter((point) => point.at !== playedAt);
    if (left.trim() && playedAt) points.push({ at: playedAt, left: Number(left) });
    if (points.length > 0) next.playersLeft = points;
    const problem = settingsProblem(next);
    if (problem) {
      setMessage(f.problems[problem] ?? problem);
      return;
    }
    setBusy(true);
    try {
      await saveTournamentSettings(tournamentKey, next);
      setSaved(next);
      setMessage(f.saved);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    try {
      await deleteTournamentSettings(tournamentKey);
      setSaved(null);
      setMessage(f.reset);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={icmStyles.form}>
      <button type="button" className="btn btn--sm" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {t.edit}
      </button>
      {open ? (
        <form
          className={icmStyles.fields}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <p className={styles.hint}>{f.intro}</p>
          <label className="field">
            <span className="field__label">{f.kind}</span>
            <select value={kind} onChange={(event) => setKind(event.target.value)}>
              <option value="">{f.kindAuto}</option>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {t.kinds[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">{f.payouts}</span>
            <input value={payouts} inputMode="decimal" placeholder={f.payoutsExample} onChange={(event) => setPayouts(event.target.value)} />
          </label>
          <label className="field">
            <span className="field__label">{f.entrants}</span>
            <input value={entrants} inputMode="numeric" onChange={(event) => setEntrants(event.target.value)} />
          </label>
          <label className="field">
            <span className="field__label">{f.startingStack}</span>
            <input value={startingStack} inputMode="numeric" onChange={(event) => setStartingStack(event.target.value)} />
          </label>
          <label className="field">
            <span className="field__label">{f.playersLeft}</span>
            <input value={left} inputMode="numeric" disabled={!playedAt} onChange={(event) => setLeft(event.target.value)} />
          </label>
          <div className={icmStyles.actions}>
            <button type="submit" className="btn btn--primary btn--sm" disabled={busy}>
              {f.save}
            </button>
            {saved ? (
              <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void reset()}>
                {f.resetButton}
              </button>
            ) : null}
          </div>
          {message ? (
            <p className={styles.hint} role="status">
              {message}
            </p>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
