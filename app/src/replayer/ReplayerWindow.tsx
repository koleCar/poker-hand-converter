/**
 * The replayer's own window (`src-tauri/src/replayer.rs`): the hand chosen
 * on the Hands screen, in the web's replayer at the web's width, with its
 * tags and note behind a header button (`HandPanel`). It asks for its hand when it loads and is told each new one
 * after that; the hand's row (for the room's name) and the tags in use are
 * read here. Its close button closes the window; a tag or note changed here
 * is told to the main window, whose list shows it.
 *
 * Several hands replayed at once (a list's right-click menu) come with
 * their list: a narrow sidebar of the hero's cards, one entry per hand, the
 * shown one marked. A click there, or Up / Down anywhere in the window,
 * steps to another hand (through `replayerOpen`, which keeps the list and
 * marks the hand's row in the main window). The sidebar can be hidden to a
 * small tab; the choice is remembered.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CardRow } from "@rail/ui/cards/PlayingCard";
import { handFormat, stakes } from "@rail/ui/hands/format";
import { useUiStrings } from "@rail/ui/i18n";
import { RailLoader } from "@rail/ui/loader/RailLoader";

import { useT } from "../i18n";
import { emitHandAnnotated, inApp, ipc, onReplayerHand, type HandRow, type ReplayerShow } from "../lib/ipc";
import { EMPTY_FILTER, toQuery } from "../screens/hands/filter";
import { HandPanel } from "../screens/hands/HandPanel";
import styles from "./ReplayerWindow.module.css";

/** How long to keep looking for the replayer to give it the keyboard, ms. */
const FOCUS_FOR_MS = 2000;

const NO_ROWS: ReadonlyMap<string, HandRow> = new Map();

/** The list's rows are read this many at a time. */
const ROWS_CHUNK = 500;

/** Where the sidebar's hidden or shown state is kept (a convenience only). */
const HIDDEN_KEY = "rail.replayer.listHidden";

function readHidden(): boolean {
  try {
    return window.localStorage.getItem(HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

function writeHidden(hidden: boolean): void {
  try {
    window.localStorage.setItem(HIDDEN_KEY, hidden ? "1" : "0");
  } catch {
    // Not kept: the sidebar shows again next time.
  }
}

/** The list's rows by key (the store returns them newest first). */
async function rowsOf(keys: readonly string[]): Promise<Map<string, HandRow>> {
  const rows = new Map<string, HandRow>();
  for (let start = 0; start < keys.length; start += ROWS_CHUNK) {
    for (const row of await ipc.handsByKey(keys.slice(start, start + ROWS_CHUNK))) rows.set(row.handKey, row);
  }
  return rows;
}

function sameShow(a: ReplayerShow | null, b: ReplayerShow): boolean {
  return a !== null && a.hand === b.hand && a.list.length === b.list.length && a.list.every((key, i) => key === b.list[i]);
}

export function ReplayerWindow() {
  const dict = useT();
  const t = dict.hands.panel;
  const [show, setShow] = useState<ReplayerShow | null>(null);
  const [asked, setAsked] = useState(false);
  const [fetchedRow, setFetchedRow] = useState<HandRow | null>(null);
  const [knownTags, setKnownTags] = useState<string[]>([]);
  const handKey = show?.hand ?? null;
  const list = show?.list ?? null;

  const take = useCallback((next: ReplayerShow) => setShow((was) => (sameShow(was, next) ? was : next)), []);

  // The hand: asked for once, then each new one as it is chosen.
  useEffect(() => {
    if (!inApp) return;
    ipc
      .replayerHand()
      .then((first) => {
        if (first !== null) setShow((current) => current ?? first);
      })
      .catch(() => undefined)
      .finally(() => setAsked(true));
    return onReplayerHand(take);
  }, [take]);

  // The list's rows (the hero's cards), read once per list.
  const [loaded, setLoaded] = useState<{ list: readonly string[]; rows: ReadonlyMap<string, HandRow> } | null>(null);
  useEffect(() => {
    if (list === null || list.length === 0) return;
    let live = true;
    rowsOf(list)
      .then((rows) => {
        if (live) setLoaded({ list, rows });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [list]);
  const listRows = loaded !== null && loaded.list === list ? loaded.rows : NO_ROWS;
  const listedRow = handKey === null ? undefined : listRows.get(handKey);

  // Its row (unless the list has it), and the tags in use (read again per
  // hand: a tag may be new).
  useEffect(() => {
    if (handKey === null) return;
    let live = true;
    if (!listedRow) {
      ipc
        .handsByKey([handKey])
        .then((rows) => {
          if (live) setFetchedRow(rows[0] ?? null);
        })
        .catch(() => undefined);
    }
    ipc
      .handsFacets(toQuery(EMPTY_FILTER))
      .then((facets) => {
        if (live) setKnownTags(facets.tags.map((tag) => tag.value));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [handKey, listedRow]);
  const row = listedRow ?? (fetchedRow?.handKey === handKey ? fetchedRow : null);

  // The replayer's keys (←/→, space, Home/End) work once it has focus; it
  // appears when the hand has loaded.
  useEffect(() => {
    if (handKey === null) return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      const replayer = document.querySelector<HTMLElement>(".rp");
      if (replayer) replayer.focus();
      if (replayer || Date.now() - started > FOCUS_FOR_MS) window.clearInterval(timer);
    }, 50);
    return () => window.clearInterval(timer);
  }, [handKey]);

  const listed = list !== null && list.length > 1 ? list : null;
  const at = listed !== null && handKey !== null ? listed.indexOf(handKey) : -1;

  const stepTo = useCallback(
    (key: string) => {
      if (listed === null) return;
      take({ hand: key, list: listed });
      ipc.replayerOpen(key, false).catch(() => undefined);
    },
    [listed, take],
  );

  // Up / Down step through the list, wherever the focus is but a text field.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (listed === null || at < 0) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable) return;
    const step =
      event.key === "ArrowDown" || event.key === "PageDown"
        ? 1
        : event.key === "ArrowUp" || event.key === "PageUp"
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = listed[at + step];
    if (next !== undefined) stepTo(next);
  };

  return (
    <main className={styles.window} onKeyDown={onKeyDown}>
      {listed !== null ? <HandsSidebar keys={listed} at={at} rows={listRows} onStep={stepTo} /> : null}
      <div className={styles.hand}>
        {handKey !== null ? (
          <HandPanel
            handKey={handKey}
            row={row}
            knownTags={knownTags}
            onClose={() => {
              ipc.replayerClose().catch(() => undefined);
            }}
            onAnnotated={(key, annotations) => emitHandAnnotated({ handKey: key, annotations })}
            onNavigate={(href) => {
              ipc.replayerOpenInMain(href).catch(() => undefined);
            }}
          />
        ) : asked ? (
          <p className={styles.empty}>{t.choose}</p>
        ) : (
          <RailLoader label={t.loading} centered />
        )}
      </div>
    </main>
  );
}

/**
 * The hands being replayed, by the hero's cards alone; the shown one marked
 * and kept in view. Hidden, it is a small tab with the position.
 */
function HandsSidebar({
  keys,
  at,
  rows,
  onStep,
}: {
  keys: readonly string[];
  at: number;
  rows: ReadonlyMap<string, HandRow>;
  onStep: (key: string) => void;
}) {
  const t = useT().hands.replayList;
  const ui = useUiStrings();
  const format = useMemo(() => handFormat(ui.intlLocale), [ui.intlLocale]);
  const [hidden, setHidden] = useState(readHidden);
  const listRef = useRef<HTMLOListElement>(null);
  const position = t.position(at + 1, keys.length);

  // The shown hand stays in view as the list steps.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>("[aria-current=true]")?.scrollIntoView({ block: "nearest" });
  }, [at, hidden]);

  const toggle = (next: boolean) => {
    setHidden(next);
    writeHidden(next);
  };

  if (hidden) {
    return (
      <button
        type="button"
        className={styles.tab}
        onClick={() => toggle(false)}
        aria-label={`${t.show} (${position})`}
        title={t.show}
      >
        <span aria-hidden="true">›</span>
        <span className={styles.tabCount}>{position}</span>
      </button>
    );
  }

  return (
    <nav className={styles.sidebar} aria-label={t.label}>
      <div className={styles.sidebarHead}>
        <span className={styles.count} aria-live="polite">
          {position}
        </span>
        <button type="button" className={styles.hide} onClick={() => toggle(true)} aria-label={t.hide} title={t.hide}>
          ‹
        </button>
      </div>
      <ol ref={listRef} className={styles.list}>
        {keys.map((key, index) => {
          const row = rows.get(key);
          const title = row ? `${format.playedAt(row.playedAt)} · ${stakes(row)} · ${row.siteName}` : undefined;
          return (
            <li key={key}>
              <button
                type="button"
                className={styles.entry}
                aria-current={index === at ? true : undefined}
                title={title}
                onClick={() => onStep(key)}
              >
                {row === undefined ? (
                  <span className={styles.placeholder} aria-hidden="true" />
                ) : row.heroCards.length > 0 ? (
                  <CardRow cards={row.heroCards} size="xs" />
                ) : (
                  <span className={styles.noCards}>{t.noCards}</span>
                )}
                {title ? <span className={styles.visuallyHidden}>{title}</span> : null}
              </button>
            </li>
          );
        })}
      </ol>
      <div className={styles.steps}>
        <button
          type="button"
          className={styles.step}
          disabled={at <= 0}
          onClick={() => onStep(keys[at - 1] as string)}
          aria-label={t.previous}
          title={t.previous}
        >
          ↑
        </button>
        <button
          type="button"
          className={styles.step}
          disabled={at < 0 || at >= keys.length - 1}
          onClick={() => onStep(keys[at + 1] as string)}
          aria-label={t.next}
          title={t.next}
        >
          ↓
        </button>
      </div>
    </nav>
  );
}
