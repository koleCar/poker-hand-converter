/**
 * What a table of hands does with the hands chosen in it (Hands, Live,
 * Analysis; 2026-11-16, the owner: every table chooses several hands and
 * replays and tags them): a right-click menu, and with two or more chosen a
 * bar at the window's foot with the same actions in view. The hands are
 * replayed in the replayer window - several with their list beside it -
 * tagged (`MarkPanel`: a dropdown of the tags, presets first, and a field
 * for a tag of one's own; "Review" queues the spot for the solver), or saved
 * as one hand-history .txt (`export.rs`), the text Rail and the web read back.
 * What a save did is said for a few seconds at the window's foot.
 */
import { ContextMenu, type MenuPoint } from "@rail/ui/hands/ContextMenu";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useT } from "../i18n";
import { errorText, ipc } from "../lib/ipc";
import styles from "./HandActions.module.css";
import { MarkPanel } from "./MarkPanel";

/** How long a save's message stays, ms. */
const NOTICE_MS = 6000;

/** Today as YYYY-MM-DD, for the file's suggested name. */
function today(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export interface HandActions {
  /** Open the menu for these hands (in the list's order) at the pointer. */
  openMenu: (handKeys: string[], at: MenuPoint) => void;
  /**
   * The bar for the chosen hands (in the list's order), shown while two or
   * more are chosen; `clear` lets them go.
   */
  bar: (handKeys: readonly string[], clear: () => void) => ReactNode;
  /** The menu and the message, rendered once by the screen. */
  element: ReactNode;
}

export function useHandActions(): HandActions {
  const t = useT().hands.actions;
  const [menu, setMenu] = useState<{ keys: string[]; at: MenuPoint } | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    if (notice === null) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const openMenu = useCallback((keys: string[], at: MenuPoint) => {
    if (keys.length > 0) setMenu({ keys, at });
  }, []);
  const close = useCallback(() => setMenu(null), []);

  const replay = useCallback((keys: string[]) => {
    ipc.replayerOpenList(keys, true).catch((error: unknown) => setNotice({ text: errorText(error), error: true }));
  }, []);

  const save = useCallback((keys: string[]) => {
    ipc
      .handsExport(keys, t.fileName(today()))
      .then((done) => {
        if (done === null) return;
        const text = [t.exported(done.hands, done.path), done.missing > 0 ? t.missing(done.missing) : null]
          .filter(Boolean)
          .join(" · ");
        setNotice({ text, error: false });
      })
      .catch((error: unknown) => setNotice({ text: t.exportFailed(errorText(error)), error: true }));
  }, [t]);

  const bar = useCallback(
    (keys: readonly string[], clear: () => void) =>
      keys.length > 1 ? <ChosenBar handKeys={keys} onClear={clear} onReplay={replay} onSave={save} /> : null,
    [replay, save],
  );

  const element = (
    <>
      {menu !== null ? (
        <ContextMenu
          at={menu.at}
          label={t.label(menu.keys.length)}
          onClose={close}
          items={[
            { label: t.replay(menu.keys.length), onSelect: () => replay(menu.keys) },
            { label: t.mark, submenu: () => <MarkPanel handKeys={menu.keys} /> },
            { label: t.export(menu.keys.length), onSelect: () => save(menu.keys) },
          ]}
        />
      ) : null}
      {notice !== null ? (
        <div className={`${styles.notice} ${notice.error ? styles.error : ""}`} role={notice.error ? "alert" : "status"}>
          <span className={styles.text}>{notice.text}</span>
          <button type="button" className={styles.dismiss} aria-label={t.dismiss} onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      ) : null}
    </>
  );

  return { openMenu, bar, element };
}

/**
 * The chosen hands' actions, in view while two or more are chosen: how
 * many, Replay, Tag (the tags as a dropdown, a field for a new one), Export,
 * and × to let them go (Escape does too, in the list).
 */
function ChosenBar({
  handKeys,
  onClear,
  onReplay,
  onSave,
}: {
  handKeys: readonly string[];
  onClear: () => void;
  onReplay: (keys: string[]) => void;
  onSave: (keys: string[]) => void;
}) {
  const ui = useT().hands;
  const t = ui.actions;
  const [tagging, setTagging] = useState(false);
  const tagBox = useRef<HTMLDivElement>(null);
  // The same hands keep the same list, so the tag panel does not read its
  // tags again each time the screen draws.
  const joined = handKeys.join("\n");
  const keys = useMemo(() => joined.split("\n"), [joined]);

  useEffect(() => {
    if (!tagging) return;
    tagBox.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    const onDown = (event: PointerEvent) => {
      if (!tagBox.current?.contains(event.target as Node)) setTagging(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setTagging(false);
      tagBox.current?.querySelector<HTMLElement>("button")?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [tagging]);

  return (
    <div className={styles.bar} role="toolbar" aria-label={t.label(keys.length)}>
      <span className={styles.count}>{ui.chosen(keys.length)}</span>
      <button type="button" className={styles.action} onClick={() => onReplay(keys)}>
        {t.bar.replay}
      </button>
      <div ref={tagBox} className={styles.tagBox}>
        <button
          type="button"
          className={`${styles.action} ${tagging ? styles.open : ""}`.trim()}
          aria-haspopup="menu"
          aria-expanded={tagging}
          onClick={() => setTagging((open) => !open)}
        >
          {t.bar.tag}
          <span className={styles.caret} aria-hidden="true">
            ▾
          </span>
        </button>
        {tagging ? (
          <div className={styles.dropdown} role="menu" aria-label={t.markers.label}>
            <MarkPanel handKeys={keys} />
          </div>
        ) : null}
      </div>
      <button type="button" className={styles.action} onClick={() => onSave(keys)}>
        {t.bar.export}
      </button>
      <button type="button" className={styles.dismiss} aria-label={t.bar.clear} title={t.bar.clear} onClick={onClear}>
        ×
      </button>
    </div>
  );
}
