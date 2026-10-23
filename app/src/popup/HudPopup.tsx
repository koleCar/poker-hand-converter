/**
 * The HUD popup (R3.8): the app's own small window beside a panel the user
 * clicked at a table (`src-tauri/src/popup.rs` opens and places it). It
 * shows, for that player, what the room's HUD rules allow:
 *
 * - their statistics - every R2.4 definition for any player that the HUD
 *   shows (panel and popup) - over the table's game, from the user's own
 *   hands only where the room asks, coloured as on the panel (at most two
 *   thresholds), with R2.5's reliability; grouped like the Players screen;
 * - the legend: each statistic's thresholds in use, in words;
 * - hands together and your result against them (big blinds, cash and
 *   tournaments apart, never added);
 * - their rows by position, unless the room forbids a display that changes
 *   with position (PokerStars; Winamax read as conservatively) - then a
 *   line says why;
 * - where the room allows labelling players (Winamax; not PokerStars, not
 *   ACR), the user's words - colour, labels and note - editable; elsewhere
 *   a line says they stay in the Players screen.
 *
 * Nothing about the hand in play, no advice: historical statistics only
 * (guideline §7). Esc closes it, so does its close button and the pointer
 * leaving it once it came in (unless the keyboard is in it: a note being
 * typed); a click elsewhere after it got the keyboard closes it from the
 * Rust side. The window opens without taking the keyboard from the table.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { StatDefinition, StatGroup as DefinitionGroup } from "@rail/ui/model/stats";
import { StatTable } from "@rail/ui/stats/StatTable";

import { StateMessage } from "../components/StateMessage";
import { useLocale, useT } from "../i18n";
import { errorText, inApp, ipc, onHudPopupChanged, type HudPopup as Popup, type PopupBand } from "../lib/ipc";
import { statRows, useStatDefinitions } from "../lib/useStatDefinitions";
import { POSITION_ORDER } from "../screens/hands/filter";
import { bigBlinds, count } from "../screens/hands/format";
import { storePlayersSource } from "../lib/playersSource";
import { PlayerWords } from "@rail/ui/players/PlayerProfile";
import { GroupTable } from "@rail/ui/reports/Breakdown";
import styles from "./HudPopup.module.css";

const GROUPS: DefinitionGroup[] = ["preflop", "postflop", "showdown", "results"];

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
  const closeRef = useRef<HTMLButtonElement>(null);
  const shown = (definition: StatDefinition) => popup.ids.includes(definition.id);
  const thresholds = Math.max(
    0,
    ...popup.legend.map((entry) => entry.bands.length - 1),
  );

  return (
    <article className={styles.body} aria-labelledby={headingId}>
      <header className={styles.head}>
        <div className={styles.who}>
          <h1 id={headingId} className={styles.name}>
            {popup.hero ? `${popup.player} (${t.you})` : popup.player}
          </h1>
          <p className={styles.muted}>
            {popup.table ? t.tableAt(popup.siteName, popup.table) : popup.siteName}
          </p>
        </div>
        <button
          ref={closeRef}
          type="button"
          className="btn btn--icon"
          aria-label={t.close}
          title={t.close}
          onClick={onClose}
        >
          ×
        </button>
      </header>

      {popup.opaque ? <p className={styles.notice}>{t.opaque}</p> : null}

      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt>{t.sample(popup.hands)}</dt>
          {popup.rules.ownHandsOnly ? <dd className={styles.muted}>{t.ownHands}</dd> : null}
        </div>
        {popup.together ? (
          <>
            <div className={styles.fact}>
              <dt>{t.together}</dt>
              <dd>
                {popup.together.cash.hands + popup.together.chips.hands > 0
                  ? count(popup.together.cash.hands + popup.together.chips.hands)
                  : t.noTogether}
              </dd>
            </div>
            {popup.together.cash.moneyHands > 0 || popup.together.chips.moneyHands > 0 ? (
              <div className={styles.fact}>
                <dt>{t.result}</dt>
                {popup.together.cash.moneyHands > 0 ? (
                  <dd className={tone(popup.together.cash.netBbMilli)}>
                    {t.resultCash(bigBlinds(popup.together.cash.netBbMilli), popup.together.cash.moneyHands)}
                  </dd>
                ) : null}
                {popup.together.chips.moneyHands > 0 ? (
                  <dd className={tone(popup.together.chips.netBbMilli)}>
                    {t.resultChips(bigBlinds(popup.together.chips.netBbMilli), popup.together.chips.moneyHands)}
                  </dd>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
      </dl>

      {popup.notes ? (
        <section className={styles.section} aria-label={t.note}>
          <PlayerWords
            source={storePlayersSource}
            site={popup.storeSite}
            player={popup.player}
            initial={popup.notes}
            onNotes={() => undefined}
          />
        </section>
      ) : popup.together && !popup.rules.words ? (
        <p className={styles.muted}>{t.wordsHidden(popup.siteName)}</p>
      ) : null}

      <section className={styles.section}>
        <h2 className={styles.subhead}>{t.stats}</h2>
        {definitions === null ? (
          <StateMessage kind="loading" compact>
            {t.loading}
          </StateMessage>
        ) : popup.sections !== null ? (
          // (R3.9) The table's design's sections, in its order.
          <div className={styles.groups}>
            {popup.sections.map((section, index) => {
              const rows = statRows(
                definitions,
                popup.stats,
                locale,
                (definition) => section.ids.includes(definition.id),
                popup.ids,
              ).sort((a, b) => section.ids.indexOf(a.id) - section.ids.indexOf(b.id));
              return rows.length === 0 ? null : (
                <StatTable
                  key={index}
                  caption={section.title ?? (section.group ? all.reports.stats.groups[section.group] : "")}
                  showCaption
                  rows={rows}
                />
              );
            })}
          </div>
        ) : (
          <div className={styles.groups}>
            {GROUPS.map((group) => {
              const rows = statRows(
                definitions,
                popup.stats,
                locale,
                (definition) => definition.group === group && shown(definition),
                popup.ids,
              );
              return rows.length === 0 ? null : (
                <StatTable key={group} caption={all.reports.stats.groups[group]} showCaption rows={rows} />
              );
            })}
          </div>
        )}
        <p className={styles.muted}>{t.statsNote}</p>
      </section>

      <details className={styles.section}>
        <summary className={styles.subhead}>{t.legend}</summary>
        <p className={styles.muted}>{t.legendNote(thresholds)}</p>
        {definitions === null ? null : (
          <ul className={styles.legend}>
            {popup.legend.map((entry) => {
              const definition = definitions.find((d) => d.id === entry.id);
              return definition ? (
                <li key={entry.id} className={styles.legendRow}>
                  <span className={styles.legendName}>{definition.label[locale]}</span>
                  <span className={styles.bands}>
                    {entry.bands.map((band, index) => (
                      <span key={band.tone} className={styles.band} data-tone={band.tone}>
                        {`${bandText(entry.bands, index, locale, t)} · ${t.tones[band.tone]}`}
                      </span>
                    ))}
                  </span>
                </li>
              ) : null;
            })}
          </ul>
        )}
      </details>

      {popup.together ? (
        <section className={styles.section}>
          <h2 className={styles.subhead}>{t.byPosition}</h2>
          {popup.byPosition === null ? (
            <p className={styles.muted}>{t.byPositionHidden(popup.siteName)}</p>
          ) : definitions === null ? null : (
            <GroupTable
              head={t.byPosition}
              rows={[...popup.byPosition].sort((a, b) => rank(a.key) - rank(b.key))}
              columns={popup.columns.map((id) => definitions.find((d) => d.id === id) ?? null)}
              label={(row) => (row.key === "" ? t.noPosition : row.key)}
            />
          )}
        </section>
      ) : null}

      <footer className={styles.foot}>
        {popup.together ? (
          <button
            type="button"
            className="btn"
            onClick={() => {
              ipc.hudPopupOpenInApp().catch(() => undefined);
            }}
          >
            {t.openInApp}
          </button>
        ) : null}
        <p className={styles.muted}>{t.historical}</p>
      </footer>
    </article>
  );
}

function rank(key: string): number {
  const index = POSITION_ORDER.indexOf(key);
  return index < 0 ? POSITION_ORDER.length : index;
}

function tone(netBbMilli: number): string {
  return netBbMilli > 0 ? styles.up : netBbMilli < 0 ? styles.down : "";
}

/** A band's range in words: "below 22", "22 to 30", "from 30". */
function bandText(
  bands: readonly PopupBand[],
  index: number,
  locale: string,
  t: { below: (v: string) => string; from: (v: string) => string; range: (a: string, b: string) => string },
): string {
  const number = new Intl.NumberFormat(locale === "hr" ? "hr-HR" : "en-GB", { maximumFractionDigits: 2 });
  const band = bands[index];
  const previous = index > 0 ? bands[index - 1] : undefined;
  const low = previous?.below ?? null;
  const high = band?.below ?? null;
  if (low === null && high !== null) return t.below(number.format(high));
  if (low !== null && high === null) return t.from(number.format(low));
  if (low !== null && high !== null) return t.range(number.format(low), number.format(high));
  return "";
}
