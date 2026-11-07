/**
 * A hand list's right-click menu (Hands, Live): the chosen hands replayed
 * in the replayer window - several with their list beside it - marked
 * (`MarkPanel`: markers are tags; "Review" queues the spot for the solver),
 * or saved as one hand-history .txt (`export.rs`), the text Rail and the
 * web read back.
 * What a save did is said for a few seconds at the window's foot.
 */
import { ContextMenu, type MenuPoint } from "@rail/ui/hands/ContextMenu";
import { useCallback, useEffect, useState, type ReactNode } from "react";

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

  const replay = (keys: string[]) => {
    ipc.replayerOpenList(keys, true).catch((error: unknown) => setNotice({ text: errorText(error), error: true }));
  };

  const save = (keys: string[]) => {
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
  };

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

  return { openMenu, element };
}
