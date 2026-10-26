/**
 * A tournament push/fold grade in the app's hand analysis (R5.5c): what it
 * was measured in (prize equity, or chips and why), the stacks, the payouts
 * and players left used, the hero's prize equity after each option, and the
 * hero's bubble factor and risk premium against each player - all read from
 * the grade's `facts.icm`. Under it, the tournament's settings (payouts,
 * field, players left), kept in the store (local only, Q4): saving them
 * sends the tournament's hands back to the background analysis.
 */
import { useEffect, useState } from "react";

import { useT } from "../../i18n";
import { liveNumberFormat } from "../../i18n/format";
import { settingsProblem, type DecisionAnalysis, type TournamentSettings } from "../../analysis/library";
import { runner } from "../../analysis/service";
import { inApp, ipc } from "../../lib/ipc";
import styles from "./Analysis.module.css";

const ONE = liveNumberFormat({ minimumFractionDigits: 0, maximumFractionDigits: 1 });
const TWO = liveNumberFormat({ minimumFractionDigits: 0, maximumFractionDigits: 2 });

export function IcmBlock({ decision, playedAt }: { decision: DecisionAnalysis; playedAt: string | null }) {
  const t = useT().analysis.hand.icm;
  const icm = decision.facts.icm;
  if (!icm) return null;
  const chips = icm.model === "chips";
  const pct = (value: number) => `${ONE.format(value * 100)} %`;
  const names = [t.fold, icm.scenario === "push" ? t.push : t.call];
  const heroSeat = icm.stacks.find((s) => s.hero)?.seat ?? null;
  return (
    <div className={styles.icm}>
      <p className={styles.note}>
        <strong>{chips ? t.modelChips : t.modelIcm}</strong>
        {chips && icm.chipsReason ? ` - ${t.chipsReasons[icm.chipsReason] ?? icm.chipsReason}` : ""}
      </p>
      <p className={styles.muted}>
        {t.stacks}:{" "}
        {icm.stacks.map((s) => `${s.hero ? t.you : (s.position ?? `#${s.seat}`)} ${ONE.format(s.stackBb)} bb`).join(" · ")}
      </p>
      {icm.payouts && (
        <p className={styles.muted}>
          {t.payouts}: {icm.payouts.slice(0, 9).map((p) => ONE.format(p)).join(" / ")}
          {icm.payouts.length > 9 ? " …" : ""} % ({t.sources[icm.payoutsSource ?? ""] ?? ""}) · {t.playersLeft}: {icm.playersLeft}
          {icm.playersLeftSource ? ` (${t.sources[icm.playersLeftSource] ?? ""})` : ""}
        </p>
      )}
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">{t.option}</th>
            <th scope="col">{chips ? t.equityChips : t.equity}</th>
            <th scope="col">{t.evBb}</th>
          </tr>
        </thead>
        <tbody>
          {decision.options.map((o, i) => (
            <tr key={i} className={i === decision.chosen ? styles.chosen : undefined}>
              <td>{names[i] ?? o.action}</td>
              <td>{pct(icm.equity.options[i] ?? 0)}</td>
              <td>{TWO.format(o.ev)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className={styles.muted}>{t.pushRange(icm.scenario === "push" ? t.you : (icm.pusher ?? "?"), pct(icm.pushShare))}</p>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">{t.player}</th>
            <th scope="col">{t.calls}</th>
            <th scope="col">{t.bubbleFactor}</th>
            <th scope="col">{t.riskPremium}</th>
          </tr>
        </thead>
        <tbody>
          {icm.players.map((p) => (
            <tr key={p.seat}>
              <td>{p.seat === heroSeat ? t.you : (p.position ?? `#${p.seat}`)}</td>
              <td>{pct(p.callShare)}</td>
              <td>{p.bubbleFactor === null ? "–" : TWO.format(p.bubbleFactor)}</td>
              <td>{p.riskPremium === null ? "–" : pct(p.riskPremium)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {icm.key && <SettingsForm tournamentKey={icm.key} playedAt={playedAt} playersLeft={icm.playersLeft} />}
    </div>
  );
}

function numberOrNull(text: string): number | null {
  const value = Number(text.trim());
  return text.trim() === "" || !Number.isFinite(value) ? null : value;
}

function SettingsForm({ tournamentKey, playedAt, playersLeft }: { tournamentKey: string; playedAt: string | null; playersLeft: number | null }) {
  const t = useT().analysis.hand.icm;
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<TournamentSettings | null>(null);
  const [kind, setKind] = useState("");
  const [payouts, setPayouts] = useState("");
  const [entrants, setEntrants] = useState("");
  const [stack, setStack] = useState("");
  const [left, setLeft] = useState(playersLeft === null ? "" : String(playersLeft));
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !inApp) return;
    let live = true;
    void ipc
      .tournamentSettingsList()
      .then((rows) => {
        const mine = (rows.find((row) => row.key === tournamentKey)?.settings ?? null) as TournamentSettings | null;
        if (!live) return;
        setSaved(mine);
        setKind(mine?.kind ?? "");
        setPayouts((mine?.payouts ?? []).join(", "));
        setEntrants(mine?.entrants ? String(mine.entrants) : "");
        setStack(mine?.startingStack ? String(mine.startingStack) : "");
      })
      .catch((error: unknown) => {
        if (live) setMessage(error instanceof Error ? error.message : String(error));
      });
    return () => {
      live = false;
    };
  }, [open, tournamentKey]);

  const save = async () => {
    const next: TournamentSettings = {};
    if (kind === "sng" || kind === "spin" || kind === "mtt") next.kind = kind;
    const list = payouts
      .split(/[\s,;/]+/)
      .filter(Boolean)
      .map((part) => Number(part.replace(/%$/, "")));
    if (list.length > 0) next.payouts = list;
    const n = numberOrNull(entrants);
    if (n !== null) next.entrants = n;
    const s = numberOrNull(stack);
    if (s !== null) next.startingStack = s;
    const points = (saved?.playersLeft ?? []).filter((point) => point.at !== playedAt);
    const l = numberOrNull(left);
    if (l !== null && playedAt) points.push({ at: playedAt, left: l });
    if (points.length > 0) next.playersLeft = points;
    const problem = settingsProblem(next);
    if (problem) {
      setMessage(t.invalid(problem));
      return;
    }
    try {
      const count = await ipc.tournamentSettingsSave(tournamentKey, next as Record<string, unknown>);
      setSaved(next);
      setMessage(t.saved(count));
      runner.wake();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const reset = async () => {
    try {
      await ipc.tournamentSettingsDelete(tournamentKey);
      setSaved(null);
      setMessage(t.cleared);
      runner.wake();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  if (!inApp) return <p className={styles.muted}>{t.unavailable}</p>;
  return (
    <details className={styles.options} open={open} onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
      <summary>{t.edit}</summary>
      <form
        className={styles.icmForm}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p className={styles.muted}>{t.intro}</p>
        <label>
          {t.kind}
          <select value={kind} onChange={(event) => setKind(event.target.value)}>
            <option value="">{t.kindAuto}</option>
            {(["sng", "spin", "mtt"] as const).map((k) => (
              <option key={k} value={k}>
                {t.kinds[k]}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t.payoutsField}
          <input value={payouts} inputMode="decimal" onChange={(event) => setPayouts(event.target.value)} />
        </label>
        <label>
          {t.entrants}
          <input value={entrants} inputMode="numeric" onChange={(event) => setEntrants(event.target.value)} />
        </label>
        <label>
          {t.startingStack}
          <input value={stack} inputMode="numeric" onChange={(event) => setStack(event.target.value)} />
        </label>
        <label>
          {t.leftHere}
          <input value={left} inputMode="numeric" disabled={!playedAt} onChange={(event) => setLeft(event.target.value)} />
        </label>
        <div className={styles.icmActions}>
          <button type="submit">{t.save}</button>
          {saved && (
            <button type="button" onClick={() => void reset()}>
              {t.reset}
            </button>
          )}
        </div>
        {message && (
          <p className={styles.muted} role="status">
            {message}
          </p>
        )}
      </form>
    </details>
  );
}
