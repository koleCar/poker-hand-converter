/**
 * The HUD popup (R3.8; compact since #429): the app's own small window
 * beside a panel the user clicked at a table (`src-tauri/src/popup.rs`
 * opens and places it). For that player, what the room's HUD rules allow,
 * as short as it can be - abbreviations and numbers, no sentences:
 *
 * - the name, the hands their numbers stand on (hover: the sample, the
 *   room's own-hands rule, hands together and your result against them);
 * - their statistics on four tabs - Preflop, Flop, Turn, River
 *   (`streetOf`) - as a grid of label over value, coloured as on the panel
 *   (at most two thresholds), faded by R2.5's reliability; hovering a value
 *   gives its name, sample and interval (`StatTip`);
 * - where the room allows labelling players (Winamax; not PokerStars, not
 *   ACR), the user's words - colour, labels and note - folded under "Note".
 *
 * Nothing about the hand in play, no advice: historical statistics only
 * (guideline §7). Esc closes it, so does its close button and the pointer
 * leaving it once it came in (unless the keyboard is in it: a note being
 * typed); a click elsewhere after it got the keyboard closes it from the
 * Rust side. The window opens without taking the keyboard from the table.
 */
import { useCallback, useEffect, useId, useState } from "react";
import type { StatDefinition } from "@rail/ui/model/stats";
import { useStatTip } from "@rail/ui/stats/StatTip";
import { decimalMark, shownText } from "@rail/ui/stats/StatValue";
import { PlayerWords } from "@rail/ui/players/PlayerProfile";

import { StateMessage } from "../components/StateMessage";
import { useLocale, useT } from "../i18n";
import { formatLocale } from "../i18n/format";
import { errorText, inApp, ipc, onHudPopupChanged, type HudPopup as Popup } from "../lib/ipc";
import { shownOf, useStatDefinitions } from "../lib/useStatDefinitions";
import { bigBlinds, count } from "../screens/hands/format";
import { storePlayersSource } from "../lib/playersSource";
import styles from "./HudPopup.module.css";

/** The popup's tabs, in the hand's order. */
export const STREETS = ["preflop", "flop", "turn", "river"] as const;
export type Street = (typeof STREETS)[number];

/**
 * (#429) The tab a statistic goes on: preflop ones on Preflop; a
 * postflop one by the street its id names (`_turn`, `_river`), showdown
 * on River, the rest - the flop and the whole-hand postflop figures (AF,
 * AFq, WWSF) - on Flop. Results (hands, win rate) are on no tab.
 */
export function streetOf(definition: Pick<StatDefinition, "id" | "group">): Street | null {
  if (definition.group === "results") return null;
  if (definition.group === "preflop") return "preflop";
  const id = definition.id;
  if (id.endsWith("_river") || id === "wtsd" || id === "wsd") return "river";
  if (id.endsWith("_turn")) return "turn";
  return "flop";
}

/** How long the pointer may be away before the popup closes. */
const LEAVE_MS = 350;

export function HudPopupWindow() {
  const t = useT().hudPopup;
  const [popup, setPopup] = useState<Popup | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "none" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  const close = useCallback(() => {
    ipc.hudPopupClose().catch(() => undefined);
  }, []);

  // What to show: now, and again whenever another panel is clicked.
  useEffect(() => onHudPopupChanged(() => setGeneration((n) => n + 1)), []);
  useEffect(() => {
    if (!inApp) return;
    let live = true;
    ipc
      .hudPopup()
      .then((value) => {
        if (!live) return;
        setPopup(value);
        setState(value === null ? "none" : "ready");
      })
      .catch((reason: unknown) => {
        if (!live) return;
        setError(errorText(reason));
        setState("error");
      });
    return () => {
      live = false;
    };
  }, [generation]);

  // Esc closes; the pointer leaving (after it came in) closes unless the
  // keyboard is in the popup.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    let entered = false;
    let timer: number | undefined;
    const typing = () => {
      const active = document.activeElement;
      return active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement;
    };
    const onEnter = () => {
      entered = true;
      window.clearTimeout(timer);
    };
    const onLeave = () => {
      if (!entered || typing()) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(close, LEAVE_MS);
    };
    document.addEventListener("keydown", onKey);
    document.documentElement.addEventListener("mouseenter", onEnter);
    document.documentElement.addEventListener("mouseleave", onLeave);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", onKey);
      document.documentElement.removeEventListener("mouseenter", onEnter);
      document.documentElement.removeEventListener("mouseleave", onLeave);
    };
  }, [close]);

  return (
    <main className={styles.popup} aria-label={popup ? t.label(popup.player) : undefined}>
      {state === "loading" ? (
        <StateMessage kind="loading" compact>
          {t.loading}
        </StateMessage>
      ) : state === "error" ? (
        <StateMessage kind="error" compact>
          {t.failed(error ?? "")}
        </StateMessage>
      ) : state === "none" || popup === null ? (
        <StateMessage kind="empty" compact>
          {t.none}
        </StateMessage>
      ) : (
        <PopupBody key={`${popup.storeSite}:${popup.player}`} popup={popup} onClose={close} />
      )}
    </main>
  );
}

function PopupBody({ popup, onClose }: { popup: Popup; onClose: () => void }) {
  const all = useT();
  const t = all.hudPopup;
  const locale = useLocale();
  const definitions = useStatDefinitions();
  const headingId = useId();
  const tip = useStatTip();
  const [street, setStreet] = useState<Street>("preflop");
  const mark = decimalMark(formatLocale());

  // Every statistic the popup has, on its street's tab, in the
  // definitions' order.
  const cells = (definitions ?? []).flatMap((definition) => {
    if (!popup.ids.includes(definition.id) || streetOf(definition) !== street) return [];
    const found = shownOf(definitions ?? [], popup.stats, definition.id, popup.ids);
    return found ? [found] : [];
  });
  const counts = STREETS.map((s) =>
    (definitions ?? []).filter((d) => popup.ids.includes(d.id) && streetOf(d) === s).length,
  );
  const winRate = definitions ? shownOf(definitions, popup.stats, "bb_per_100", popup.ids) : null;

  // The hands count's hover: what the numbers stand on, in words.
  const about = [
    t.sample(popup.hands),
    popup.rules.ownHandsOnly ? t.ownHands : null,
    popup.opaque ? t.opaque : null,
    popup.together
      ? `${t.together}: ${
          popup.together.cash.hands + popup.together.chips.hands > 0
            ? count(popup.together.cash.hands + popup.together.chips.hands)
            : t.noTogether
        }`
      : null,
    popup.together && popup.together.cash.moneyHands > 0
      ? t.resultCash(bigBlinds(popup.together.cash.netBbMilli), popup.together.cash.moneyHands)
      : null,
    popup.together && popup.together.chips.moneyHands > 0
      ? t.resultChips(bigBlinds(popup.together.chips.netBbMilli), popup.together.chips.moneyHands)
      : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  return (
    <article className={styles.body} aria-labelledby={headingId}>
      {tip.layer}
      <header className={styles.head}>
        <h1 id={headingId} className={styles.name} title={popup.table ?? undefined}>
          {popup.hero ? `${popup.player} (${t.you})` : popup.player}
        </h1>
        <span className={styles.hands} title={about}>
          {t.handsShort(count(popup.hands))}
        </span>
        {winRate && winRate.shown.text !== null ? (
          <span
            className={styles.hands}
            data-tone={winRate.shown.tone ?? undefined}
            {...tip.on({ definition: winRate.definition, shown: winRate.shown })}
          >
            {`${winRate.definition.label[locale]} ${shownText(winRate.shown, winRate.definition.format.unit, mark)}`}
          </span>
        ) : null}
        <span className={styles.actions}>
          {popup.together ? (
            <button
              type="button"
              className="btn btn--icon"
              aria-label={t.openInApp}
              title={t.openInApp}
              onClick={() => {
                ipc.hudPopupOpenInApp().catch(() => undefined);
              }}
            >
              ↗
            </button>
          ) : null}
          <button type="button" className="btn btn--icon" aria-label={t.close} title={t.close} onClick={onClose}>
            ×
          </button>
        </span>
      </header>

      <div className={styles.tabs} role="tablist" aria-label={t.stats}>
        {STREETS.map((s, index) => (
          <button
            key={s}
            type="button"
            role="tab"
            className={`chip-btn${s === street ? " is-active" : ""}`}
            aria-selected={s === street}
            disabled={counts[index] === 0}
            onClick={() => setStreet(s)}
          >
            {t.streets[s]}
          </button>
        ))}
      </div>

      {definitions === null ? (
        <StateMessage kind="loading" compact>
          {t.loading}
        </StateMessage>
      ) : (
        <ul className={styles.grid} role="tabpanel" aria-label={t.streets[street]}>
          {cells.map(({ definition, shown }) => (
            <li
              key={definition.id}
              className={styles.cell}
              data-tone={shown.tone ?? undefined}
              {...tip.on({ definition, shown })}
            >
              <span className={styles.label}>{definition.label[locale]}</span>
              <span className={styles.value} style={{ opacity: shown.reliability.opacity }}>
                {shownText(shown, definition.format.unit, mark).replace(/%$/, "")}
              </span>
            </li>
          ))}
        </ul>
      )}

      {popup.notes ? (
        <details className={styles.words}>
          <summary>{t.note}</summary>
          <PlayerWords
            source={storePlayersSource}
            site={popup.storeSite}
            player={popup.player}
            initial={popup.notes}
            onNotes={() => undefined}
          />
        </details>
      ) : null}
    </article>
  );
}
