/**
 * The Live screen's hands: every hand of the session, newest first, ten to
 * a page - the hero's cards, the board, the position, and the pot and the
 * result both in the screen's unit (big blinds or the hand's money). The
 * whole row opens the hand (a click, or Enter on the row's link); a hovered
 * row says so with its background, an accent edge and an arrow at its end.
 *
 * The session's hands are read whole (the store's pages of up to 500,
 * following its cursor; a session is hundreds of hands, not thousands) and
 * read again whenever its hand count changes, so a new hand appears at the
 * top while the reader stays on their page.
 *
 * Several hands can be chosen as in the Hands list (Cmd/Ctrl + click one,
 * Shift + click a run, across pages); a right click replays them or saves
 * them as a .txt (`components/HandActions`).
 */
import { kindFormats, type GameKind } from "@rail/ui/hands/gameKind";
import { CardRow } from "@rail/ui/cards/PlayingCard";
import type { MenuPoint } from "@rail/ui/hands/ContextMenu";
import { useHandSelection, type HandSelection } from "@rail/ui/hands/useHandSelection";
import { useEffect, useState, type MouseEvent } from "react";

import { useHandActions } from "../../components/HandActions";
import { StateMessage } from "../../components/StateMessage";
import { useT } from "../../i18n";
import { liveNumberFormat } from "../../i18n/format";
import { errorText, ipc, type HandCursor, type HandRow, type Session } from "../../lib/ipc";
import { go, screenHref } from "../../lib/router";
import { bigBlinds, money, signedMoney, unitOf } from "../hands/format";
import { HANDS_PER_PAGE, pageList } from "./model";
import type { LiveUnit } from "./units";
import styles from "./Live.module.css";

/** The store's largest page. */
const STORE_PAGE = 500;
/** Never more than this many rows read for one session. */
const MAX_ROWS = 5000;

const BB = liveNumberFormat({ maximumFractionDigits: 1, minimumFractionDigits: 1 });

const NO_ROWS: HandRow[] = [];

/** Every hand of `kind` since `from`, newest first. */
async function sessionHands(from: string, kind: GameKind): Promise<HandRow[]> {
  const rows: HandRow[] = [];
  let after: HandCursor | null = null;
  do {
    const page = await ipc.handsPage({ from, formats: kindFormats(kind) }, after, STORE_PAGE);
    rows.push(...page.rows);
    after = page.next;
  } while (after !== null && rows.length < MAX_ROWS);
  return rows;
}

function useSessionHands(from: string, hands: number, kind: GameKind): { rows: HandRow[] | null; error: string | null } {
  const [state, setState] = useState<{ rows: HandRow[] | null; error: string | null }>({ rows: null, error: null });
  useEffect(() => {
    let live = true;
    sessionHands(from, kind)
      .then((rows) => {
        if (live) setState({ rows, error: null });
      })
      .catch((error: unknown) => {
        if (live) setState((was) => ({ ...was, error: errorText(error) }));
      });
    return () => {
      live = false;
    };
  }, [from, hands, kind]);
  return state;
}

function tone(value: number | null): string {
  return value === null || value === 0 ? "" : value > 0 ? styles.up : styles.down;
}

export function LiveHands({ session, kind, unit }: { session: Session; kind: GameKind; unit: LiveUnit }) {
  const t = useT();
  const d = t.live.handList;
  const { rows, error } = useSessionHands(session.startedAt, session.hands, kind);
  const [page, setPage] = useState(1);
  const selection = useHandSelection(rows ?? NO_ROWS);
  const actions = useHandActions();

  let body;
  if (rows === null) {
    body =
      error !== null ? (
        <StateMessage kind="error" compact>
          {d.error(error)}
        </StateMessage>
      ) : (
        <StateMessage kind="loading" compact>
          {d.loading}
        </StateMessage>
      );
  } else {
    const pages = Math.max(1, Math.ceil(rows.length / HANDS_PER_PAGE));
    const current = Math.min(page, pages);
    const first = (current - 1) * HANDS_PER_PAGE;
    const shown = rows.slice(first, first + HANDS_PER_PAGE);
    body = (
      <div className={styles.tableCard}>
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{d.columns.hand}</th>
                <th scope="col">{d.columns.board}</th>
                <th scope="col">{d.columns.position}</th>
                <th scope="col" className={styles.number}>
                  {d.columns.pot}
                </th>
                <th scope="col" className={styles.number}>
                  {d.columns.result}
                </th>
                <th scope="col" className={styles.arrowCell}>
                  <span className={styles.visuallyHidden}>{d.columns.open}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row, index) => (
                <HandLine
                  key={row.handKey}
                  row={row}
                  newest={current === 1 && index === 0}
                  unit={unit}
                  selection={selection}
                  onMenu={actions.openMenu}
                />
              ))}
            </tbody>
          </table>
        </div>
        {pages > 1 ? (
          <nav className={styles.pager} aria-label={d.pages}>
            <span className={styles.muted}>
              {d.range(first + 1, Math.min(first + HANDS_PER_PAGE, rows.length), rows.length)}
              {selection.size > 1 ? ` · ${t.hands.chosen(selection.size)}` : null}
            </span>
            <span className={styles.pages}>
              <button
                type="button"
                className={styles.pageButton}
                aria-label={d.previous}
                disabled={current === 1}
                onClick={() => setPage(current - 1)}
              >
                ‹
              </button>
              {pageList(current, pages).map((item, index) =>
                item === null ? (
                  <span key={`gap-${index}`} className={styles.gap} aria-hidden="true">
                    …
                  </span>
                ) : (
                  <button
                    key={item}
                    type="button"
                    className={styles.pageButton}
                    aria-label={d.page(item)}
                    aria-current={item === current ? "page" : undefined}
                    onClick={() => setPage(item)}
                  >
                    {item}
                  </button>
                ),
              )}
              <button
                type="button"
                className={styles.pageButton}
                aria-label={d.next}
                disabled={current === pages}
                onClick={() => setPage(current + 1)}
              >
                ›
              </button>
            </span>
          </nav>
        ) : null}
      </div>
    );
  }

  return (
    <section className={styles.section} aria-label={d.label}>
      {body}
      {actions.element}
    </section>
  );
}

function HandLine({
  row,
  newest,
  unit,
  selection,
  onMenu,
}: {
  row: HandRow;
  newest: boolean;
  unit: LiveUnit;
  selection: HandSelection;
  onMenu: (handKeys: string[], at: MenuPoint) => void;
}) {
  const t = useT();
  const d = t.live.handList;
  const pot =
    unit === "money"
      ? money(unitOf(row), row.totalPot)
      : row.bigBlind > 0
        ? d.bb(BB.format(row.totalPot / row.bigBlind))
        : "—";
  const inMoney = unit === "money" && row.heroNet !== null;
  const result = inMoney
    ? signedMoney(unitOf(row), row.heroNet as number)
    : row.heroNetBbMilli !== null
      ? d.bb(bigBlinds(row.heroNetBbMilli))
      : "—";
  const open = () => go("hands", row.handKey);
  // A plain click opens the hand; with Cmd/Ctrl or Shift it only chooses.
  const click = (event: MouseEvent) => {
    if (!selection.click(row.handKey, event)) open();
  };
  // A plain click leaves the screen, so a chosen row was chosen with a modifier.
  const chosen = selection.checked.has(row.handKey);
  return (
    <tr
      className={chosen ? `${styles.handRow} ${styles.chosen}` : styles.handRow}
      aria-selected={selection.size > 0 ? chosen : undefined}
      onClick={click}
      onMouseDown={(event) => {
        if (event.shiftKey) event.preventDefault();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        const box = event.currentTarget.getBoundingClientRect();
        const keyboard = event.clientX === 0 && event.clientY === 0;
        onMenu(selection.forMenu(row.handKey), keyboard ? { x: box.left + 24, y: box.bottom } : { x: event.clientX, y: event.clientY });
      }}
    >
      <td>
        <span className={styles.handCell}>
          <a
            className={styles.handLink}
            href={screenHref("hands", row.handKey)}
            aria-label={d.openHand(row.siteHandId)}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              click(event);
            }}
          >
            {row.heroCards.length > 0 ? <CardRow cards={row.heroCards} size="xs" /> : "—"}
          </a>
          {newest ? <span className={styles.newBadge}>{d.newest}</span> : null}
        </span>
      </td>
      <td>
        <span className={styles.boardCell}>
          {row.board.length > 0 ? (
            <CardRow cards={row.board} size="xs" />
          ) : (
            <span className={styles.muted}>{d.preflop}</span>
          )}
        </span>
      </td>
      <td className={styles.position}>{row.heroPosition ?? "—"}</td>
      <td className={`${styles.number} ${styles.muted}`}>{pot}</td>
      <td className={styles.number}>
        <span className={`${styles.result} ${tone(inMoney ? row.heroNet : row.heroNetBbMilli)}`}>{result}</span>
      </td>
      <td className={styles.arrowCell}>
        <span className={styles.arrow} aria-hidden="true">
          ›
        </span>
      </td>
    </tr>
  );
}
