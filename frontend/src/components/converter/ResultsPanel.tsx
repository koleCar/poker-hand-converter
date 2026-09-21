/**
 * Everything that came out of a conversion.
 *
 * Three levels, in the order people actually look at them: the headline numbers
 * and the download buttons, then a row per uploaded file, then the individual
 * hands. The hand list is the part that did not exist before and is the whole
 * point of the page — every row can be opened in the replayer, which is the one
 * link between the two halves of this app.
 */

import { memo, useMemo, useState } from "react";
import { toStandardTextFile } from "../../lib/phf";
import type { PhfHand } from "../../lib/phf/types";
import { downloadText, outputFileName } from "./handoff";
import { toHandRow } from "./handSummary";
import { formatBytes, formatCount } from "./inputs";
import type { SaveState, SourceResult } from "./types";

/** Hands shown before the "show more" button; a page of 6 000 rows helps nobody. */
const HAND_PAGE = 30;

/**
 * One row of the converted-hand list.
 *
 * Memoized because the list is rendered live while hands are still streaming
 * in: a row that is already on screen never changes, so re-reconciling all
 * thirty of them eight times a second is work with no output. `toHandRow` runs
 * inside the memo for the same reason.
 */
const HandRowItem = memo(function HandRowItem({
  hand,
  onPreview,
  onOpenInReplayer,
}: {
  hand: PhfHand;
  onPreview(hand: PhfHand): void;
  onOpenInReplayer(hand: PhfHand): void;
}) {
  const row = toHandRow(hand);
  return (
    <li className="conv-hand">
      <div className="conv-hand__info">
        <div className="conv-hand__line">
          <span className="conv-hand__stakes">{row.stakes}</span>
          {row.heroCards.length ? (
            <span className="conv-hand__cards">{row.heroCards.join(" ")}</span>
          ) : null}
          {row.board.length ? <span className="conv-hand__board">{row.board.join(" ")}</span> : null}
        </div>
        <div className="conv-hand__meta">
          <span>#{row.handId}</span>
          {row.table ? <span>{row.table}</span> : null}
          <span>{row.seats} players</span>
          <span>pot {row.pot}</span>
          {row.heroNet ? (
            <span className={`conv-hand__net is-${row.netDirection}`}>{row.heroNet}</span>
          ) : null}
        </div>
      </div>
      <div className="conv-hand__actions">
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => onPreview(hand)}>
          Preview
        </button>
        <button type="button" className="btn btn--sm" onClick={() => onOpenInReplayer(hand)}>
          Replay
        </button>
      </div>
    </li>
  );
});

/**
 * Chip-sized site name.
 *
 * A few parsers cover several skins and carry the whole list in their name —
 * "Chico Network (BetOnline / PayNoRake / ActionPoker / Gear Poker)" is 62
 * characters and blows out a 390px row. The parenthesis is where the brand
 * ends and the skin list begins, so the chip shows the brand and the full
 * name stays on the element's `title`.
 */
function shortSiteName(name: string): string {
  const cut = name.indexOf(" (");
  return cut > 0 ? name.slice(0, cut) : name;
}

interface ResultsPanelProps {
  sources: SourceResult[];
  saveState: SaveState;
  dbConfigured: boolean;
  autoSave: boolean;
  /** Retry after a save error, so a failed write never costs the conversion. */
  onRetrySave(): void;
  onPreview(hand: PhfHand): void;
  onOpenInReplayer(hand: PhfHand): void;
  siteLabel(siteId: string | null): string;
  /** True while batches are still arriving; the panel renders live. */
  converting: boolean;
}

export function ResultsPanel({
  sources,
  saveState,
  dbConfigured,
  autoSave,
  onRetrySave,
  onPreview,
  onOpenInReplayer,
  siteLabel,
  converting,
}: ResultsPanelProps) {
  const [visible, setVisible] = useState(HAND_PAGE);
  const [openSource, setOpenSource] = useState<string | null>(null);

  const totals = useMemo(() => {
    const bySite = new Map<string, number>();
    let hands = 0;
    let failures = 0;
    let filesWithHands = 0;
    for (const source of sources) {
      hands += source.hands.length;
      failures += source.failures.length;
      if (source.hands.length > 0) {
        filesWithHands += 1;
      }
      for (const hand of source.hands) {
        bySite.set(hand.meta.siteId, (bySite.get(hand.meta.siteId) ?? 0) + 1);
      }
    }
    return {
      hands,
      failures,
      filesWithHands,
      sites: [...bySite.entries()].sort((a, b) => b[1] - a[1]),
    };
  }, [sources]);

  // Only the rows actually on screen are materialised.
  //
  // This memo re-runs on every streamed batch, and flattening 6 000 hands into
  // 6 000 wrapper objects twenty times over is pure garbage for a list that
  // never shows more than a few dozen rows. In upload order, so "the first hand
  // of the first file" is the first row — which is what someone checking the
  // output expects to see.
  //
  // The row key carries the source id and the position, not the hand key:
  // uploading the same session twice, or a zip holding a file you already
  // dropped, legitimately produces the same hand twice and React needs to tell
  // the two rows apart. Deduping happens at save time, where it belongs; the
  // results list shows the user exactly what they gave us.
  const visibleHands = useMemo(() => {
    const rows: Array<{ hand: PhfHand; key: string }> = [];
    for (const source of sources) {
      for (let index = 0; index < source.hands.length; index += 1) {
        if (rows.length >= visible) {
          return rows;
        }
        rows.push({ hand: source.hands[index], key: `${source.id}:${index}` });
      }
    }
    return rows;
  }, [sources, visible]);

  function downloadAll() {
    // Built here rather than held in a memo: the combined file is wanted once,
    // at the end, and keeping a second copy of every hand around for the whole
    // session to save 80 ms at click time is a bad trade.
    const allHands = sources.flatMap((source) => source.hands);
    if (allHands.length === 0) {
      return;
    }
    // Local date, not `toISOString()`: a user converting at 00:30 in Berlin
    // would otherwise get yesterday's date on the file.
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
      now.getDate(),
    ).padStart(2, "0")}`;
    downloadText(
      `pokerconverter ${stamp} - ${allHands.length} ${allHands.length === 1 ? "hand" : "hands"}.txt`,
      toStandardTextFile(allHands),
    );
  }

  const savedLine = (() => {
    // Nothing is claimed about saving until the conversion is over; the save
    // has not started yet and a line that says so is just noise on top of the
    // progress bar sitting directly above.
    if (converting) {
      return null;
    }
    if (!dbConfigured) {
      return "Saving is off in this build — download the file to keep your hands.";
    }
    if (!autoSave) {
      return "Saving is switched off. Your hands stay in this tab only.";
    }
    switch (saveState.status) {
      case "saving":
        return `Saving to your library… ${formatCount(saveState.done)} of ${formatCount(saveState.total)}`;
      case "done":
        return `${formatCount(saveState.inserted)} saved to your library${
          saveState.duplicates ? `, ${formatCount(saveState.duplicates)} already there` : ""
        }.`;
      case "error":
        return "Some hands could not be saved. Your converted file is still complete.";
      default:
        return null;
    }
  })();

  // A run the user stopped still shows its partial output, so the heading has
  // to say that the number is partial — otherwise a cancelled 6 000-hand job
  // reads exactly like a finished 1 158-hand one.
  const stopped = sources.some((source) => source.status === "cancelled");

  return (
    <section className="card conv-results">
      <header className="card__head conv-results__head">
        <div>
          <h3>
            {formatCount(totals.hands)} {totals.hands === 1 ? "hand" : "hands"} converted
            {stopped ? " so far" : ""}
          </h3>
          {savedLine ? <p className="muted">{savedLine}</p> : null}
        </div>
        <div className="conv-results__head-actions">
          {/* Disabled mid-run so nobody walks away with half a file by
              accident. Stopping the run re-enables it, which is the honest way
              to get partial output. */}
          <button
            type="button"
            className="btn btn--primary"
            onClick={downloadAll}
            disabled={!totals.hands || converting}
          >
            Download all
          </button>
        </div>
      </header>

      {saveState.status === "error" ? (
        <p className="notice notice--warn conv-results__save-error">
          <span>{saveState.errors[0] ?? "The database refused the write."}</span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onRetrySave}>
            Try saving again
          </button>
        </p>
      ) : null}

      <div className="conv-stats">
        <div className="conv-stat">
          <span className="conv-stat__value">{formatCount(totals.hands)}</span>
          <span className="conv-stat__label">{totals.hands === 1 ? "hand" : "hands"}</span>
        </div>
        <div className="conv-stat">
          <span className="conv-stat__value">{formatCount(totals.filesWithHands)}</span>
          <span className="conv-stat__label">of {formatCount(sources.length)} files</span>
        </div>
        {dbConfigured && autoSave && !converting ? (
          <div className="conv-stat conv-stat--good">
            <span className="conv-stat__value">{formatCount(saveState.inserted)}</span>
            <span className="conv-stat__label">saved</span>
          </div>
        ) : null}
        {/* Re-uploading a session you already imported is normal, and a lone
            "0 saved" tile reads like something broke until you see why. */}
        {dbConfigured && autoSave && !converting && saveState.duplicates > 0 ? (
          <div className="conv-stat">
            <span className="conv-stat__value">{formatCount(saveState.duplicates)}</span>
            <span className="conv-stat__label">already in your library</span>
          </div>
        ) : null}
        {totals.failures ? (
          <div className="conv-stat conv-stat--warn">
            <span className="conv-stat__value">{formatCount(totals.failures)}</span>
            <span className="conv-stat__label">not converted</span>
          </div>
        ) : null}
      </div>

      {totals.sites.length > 0 ? (
        <div className="conv-sites" aria-label="Sites detected">
          {totals.sites.map(([siteId, count]) => {
            const full = siteLabel(siteId);
            return (
              <span key={siteId} className="conv-chip conv-chip--site" title={full}>
                <span className="conv-chip__text">{shortSiteName(full)}</span>
                <em>{formatCount(count)}</em>
              </span>
            );
          })}
        </div>
      ) : null}

      {/* Per file. A table would be unreadable at 390px, so each file is a row
          that wraps into a block instead of scrolling sideways. */}
      <ul className="conv-source-list">
        {sources.map((source) => {
          const isOpen = openSource === source.id;
          const tone = source.problem
            ? "bad"
            : source.hands.length === 0
              ? "warn"
              : source.failures.length
                ? "mixed"
                : "ok";
          return (
            <li key={source.id} className={`conv-source is-${tone}`}>
              <div className="conv-source__main">
                <div className="conv-source__name" title={source.name}>
                  <span className={`conv-dot conv-dot--${tone}`} aria-hidden="true" />
                  <span className="conv-source__text">{source.name}</span>
                </div>
                <div className="conv-source__tags">
                  {source.problem ? (
                    <span className="conv-chip conv-chip--bad">{source.problem}</span>
                  ) : (
                    <>
                      <span className="conv-chip" title={siteLabel(source.siteId)}>
                        <span className="conv-chip__text">
                          {shortSiteName(siteLabel(source.siteId))}
                        </span>
                      </span>
                      <span
                        className={`conv-chip ${source.hands.length ? "conv-chip--good" : ""}`}
                      >
                        {formatCount(source.hands.length)}{" "}
                        {source.hands.length === 1 ? "hand" : "hands"}
                      </span>
                      {source.failures.length ? (
                        <span className="conv-chip conv-chip--warn">
                          {formatCount(source.failures.length)} skipped
                        </span>
                      ) : null}
                      {source.status === "cancelled" ? (
                        <span className="conv-chip conv-chip--warn">stopped</span>
                      ) : null}
                      <span className="conv-chip conv-chip--quiet">{formatBytes(source.bytes)}</span>
                      {source.encoding !== "UTF-8" ? (
                        <span className="conv-chip conv-chip--quiet">{source.encoding}</span>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
              <div className="conv-source__actions">
                {source.hands.length ? (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() =>
                      downloadText(outputFileName(source.name), toStandardTextFile(source.hands))
                    }
                  >
                    Download
                  </button>
                ) : null}
                {source.failures.length ? (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    aria-expanded={isOpen}
                    onClick={() => setOpenSource(isOpen ? null : source.id)}
                  >
                    {isOpen ? "Hide detail" : "Detail"}
                  </button>
                ) : null}
              </div>
              {isOpen ? (
                <ul className="conv-source__detail">
                  {source.failures.slice(0, 20).map((failure, index) => (
                    <li key={`${failure.fingerprint}-${index}`}>
                      <code>{failure.reason}</code> {failure.message}
                    </li>
                  ))}
                  {source.failures.length > 20 ? (
                    <li className="muted">
                      {formatCount(source.failures.length - 20)} more — see the panel below.
                    </li>
                  ) : null}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>

      {totals.hands > 0 ? (
        <div className="conv-hands">
          <h4 className="conv-hands__title">Converted hands</h4>
          <ul className="conv-hand-list">
            {visibleHands.map(({ hand, key }) => (
              <HandRowItem
                key={key}
                hand={hand}
                onPreview={onPreview}
                onOpenInReplayer={onOpenInReplayer}
              />
            ))}
          </ul>
          {visible < totals.hands ? (
            <button
              type="button"
              className="btn btn--ghost conv-hands__more"
              onClick={() => setVisible((count) => count + HAND_PAGE * 3)}
            >
              Show more — {formatCount(totals.hands - visible)} left
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
