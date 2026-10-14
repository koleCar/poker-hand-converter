/**
 * Settings, Folders (R1.5; guideline §3 "Upravljanje mapama"): the watched
 * folders with their status, and adding (the system picker: local, external
 * and network drives), changing a folder's path or room, switching it on or
 * off, recursive, poll only, removing it (its hands stay), and finding the
 * rooms' folders again. The list is `watcher_status`, refreshed when the
 * app reports a change (`useWatcherStatus`: imports, backfill progress -
 * R1.6); every change goes through the commands in `folder_settings.rs`.
 */
import { useEffect, useState } from "react";

import { Dialog } from "@rail/ui/dialog/Dialog";
import { FoundFolderTable, type FoundRow } from "../../components/FoundFolderTable";
import { ImportChoice } from "../../components/ImportChoice";
import { useT } from "../../i18n";
import { errorText, ipc, type RoomChoice, type WatchSource } from "../../lib/ipc";
import { screenHref, SETUP } from "../../lib/router";
import { useWatcherStatus } from "../../lib/useWatcherStatus";
import { FolderCard } from "./FolderCard";
import styles from "./Folders.module.css";

interface Notice {
  text: string;
  error: boolean;
}

type DialogState =
  | { kind: "add"; path: string; onlyNew: boolean; recursive: boolean; pollOnly: boolean }
  | { kind: "move"; source: WatchSource; path: string; onlyNew: boolean }
  | { kind: "remove"; source: WatchSource };

type Search =
  | { phase: "searching" }
  | { phase: "failed"; reason: string }
  | { phase: "shown"; rows: FoundRow[]; onlyNew: boolean; adding: boolean };

export function Folders() {
  const t = useT();
  const d = t.settings.folders;
  const { status, error: loadError, reload: load } = useWatcherStatus();
  const [rooms, setRooms] = useState<RoomChoice[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [search, setSearch] = useState<Search | null>(null);

  useEffect(() => {
    ipc
      .folderRooms()
      .then(setRooms)
      .catch(() => setRooms([]));
  }, []);

  /** Run one change of one folder, then say how it went and reload. */
  const change = async (id: number, action: () => Promise<string>) => {
    setBusyId(id);
    setNotice(null);
    try {
      setNotice({ text: await action(), error: false });
    } catch (e: unknown) {
      setNotice({ text: d.actionFailed(errorText(e)), error: true });
    } finally {
      setBusyId(null);
      load();
    }
  };

  const openDialog = (next: DialogState) => {
    setDialogError(null);
    setDialogBusy(false);
    setDialog(next);
  };
  const closeDialog = () => {
    if (!dialogBusy) {
      setDialog(null);
    }
  };

  /** The system picker; `null` when cancelled or failed (said in the notice). */
  const pick = async (): Promise<string | null> => {
    setPicking(true);
    try {
      return await ipc.pickFolder();
    } catch (e: unknown) {
      setNotice({ text: d.addFailed(errorText(e)), error: true });
      return null;
    } finally {
      setPicking(false);
    }
  };

  const add = async () => {
    const path = await pick();
    if (path !== null) {
      openDialog({ kind: "add", path, onlyNew: false, recursive: true, pollOnly: false });
    }
  };

  const changePath = async (source: WatchSource) => {
    const path = await pick();
    if (path !== null) {
      openDialog({ kind: "move", source, path, onlyNew: false });
    }
  };

  const confirmDialog = async () => {
    if (!dialog) {
      return;
    }
    setDialogBusy(true);
    setDialogError(null);
    try {
      let text: string;
      if (dialog.kind === "add") {
        const added = await ipc.addFolder(dialog.path, dialog.onlyNew, dialog.recursive, dialog.pollOnly ? true : null);
        text = d.addedOne(added.path);
      } else if (dialog.kind === "move") {
        const moved = await ipc.setFolderPath(dialog.source.id, dialog.path, dialog.onlyNew);
        text = d.moved(moved.moved + moved.adopted, moved.detached);
      } else {
        await ipc.removeFolder(dialog.source.id);
        text = d.removed(dialog.source.path);
      }
      setNotice({ text, error: false });
      setDialog(null);
      load();
    } catch (e: unknown) {
      setDialogError(errorText(e));
    } finally {
      setDialogBusy(false);
    }
  };

  const findAgain = async () => {
    setSearch({ phase: "searching" });
    try {
      const discovery = await ipc.discoverFolders();
      const rows = discovery.folders
        .filter((found) => !found.watched)
        .map((found) => ({ path: found.path, found, checked: true }));
      setSearch({ phase: "shown", rows, onlyNew: false, adding: false });
    } catch (e: unknown) {
      setSearch({ phase: "failed", reason: errorText(e) });
    }
  };

  const watchFound = async () => {
    if (search?.phase !== "shown") {
      return;
    }
    const chosen = search.rows.filter((row) => row.checked);
    setSearch({ ...search, adding: true });
    try {
      const added = await ipc.addFolders(
        chosen.map((row) => ({ path: row.path, site: row.found?.site ?? null })),
        search.onlyNew,
      );
      setNotice({ text: d.search.added(added.length), error: false });
      setSearch(null);
      load();
    } catch (e: unknown) {
      setSearch({ ...search, adding: false });
      setNotice({ text: d.addFailed(errorText(e)), error: true });
    }
  };

  const actionsFor = (source: WatchSource) => ({
    setEnabled: (enabled: boolean) =>
      void change(source.id, async () => {
        await ipc.setFolderEnabled(source.id, enabled);
        return d.saved;
      }),
    setRecursive: (recursive: boolean) =>
      void change(source.id, async () => {
        await ipc.setFolderRecursive(source.id, recursive);
        return d.saved;
      }),
    setPollOnly: (pollOnly: boolean) =>
      void change(source.id, async () => {
        await ipc.setFolderPollOnly(source.id, pollOnly);
        return d.saved;
      }),
    setRoom: (parser: string | null) =>
      void change(source.id, async () => d.roomSaved(await ipc.setFolderRoom(source.id, parser))),
    changePath: () => void changePath(source),
    remove: () => openDialog({ kind: "remove", source }),
  });

  const failure = loadError ?? (status && !status.running ? status.error : null);
  const chosenCount = search?.phase === "shown" ? search.rows.filter((row) => row.checked).length : 0;

  return (
    <section className={styles.section} aria-labelledby="settings-folders">
      <div className={styles.toolbar}>
        <h2 id="settings-folders" className={styles.heading}>
          {d.heading}
        </h2>
        <div className={styles.actions}>
          <button type="button" className={styles.button} disabled={picking} onClick={() => void add()}>
            {picking ? d.choosing : d.add}
          </button>
          <button
            type="button"
            className={styles.secondary}
            disabled={search?.phase === "searching"}
            onClick={() => void findAgain()}
          >
            {d.findAgain}
          </button>
        </div>
      </div>
      <p className={styles.hint}>{d.body}</p>

      <div aria-live="polite" className={styles.live}>
        {notice && <p className={notice.error ? styles.error : styles.success}>{notice.text}</p>}
      </div>

      {search && (
        <section className={styles.panel} aria-labelledby="settings-folders-search">
          <div className={styles.toolbar}>
            <h3 id="settings-folders-search" className={styles.subheading}>
              {d.search.heading}
            </h3>
            <button type="button" className={styles.link} onClick={() => setSearch(null)}>
              {d.search.close}
            </button>
          </div>
          {search.phase === "searching" && <p className={styles.muted}>{d.search.searching}</p>}
          {search.phase === "failed" && <p className={styles.error}>{d.search.failed(search.reason)}</p>}
          {search.phase === "shown" && search.rows.length === 0 && (
            <p className={styles.muted}>
              {d.search.noneNew}{" "}
              <a className={styles.link} href={screenHref(SETUP)}>
                {d.setup}
              </a>
            </p>
          )}
          {search.phase === "shown" && search.rows.length > 0 && (
            <>
              <p className={styles.body}>{d.search.found(search.rows.length)}</p>
              <FoundFolderTable
                rows={search.rows}
                disabled={search.adding}
                onToggle={(path, checked) =>
                  setSearch({
                    ...search,
                    rows: search.rows.map((row) => (row.path === path ? { ...row, checked } : row)),
                  })
                }
              />
              {chosenCount > 0 && (
                <ImportChoice
                  legend={d.search.existingHeading}
                  onlyNew={search.onlyNew}
                  onChange={(onlyNew) => setSearch({ ...search, onlyNew })}
                  disabled={search.adding}
                />
              )}
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.button}
                  disabled={search.adding || chosenCount === 0}
                  onClick={() => void watchFound()}
                >
                  {search.adding ? d.search.adding : d.search.confirm(chosenCount)}
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {failure !== null && <p className={styles.error}>{loadError ? d.loadFailed(failure) : d.notRunning(failure)}</p>}
      {!status && failure === null && <p className={styles.muted}>{d.loading}</p>}
      {status && status.sources.length === 0 && failure === null && <p className={styles.muted}>{d.empty}</p>}
      {status && status.sources.length > 0 && (
        <ul className={styles.list} aria-label={d.list}>
          {status.sources.map((source) => (
            <FolderCard
              key={source.id}
              source={source}
              rooms={rooms}
              busy={busyId === source.id}
              actions={actionsFor(source)}
            />
          ))}
        </ul>
      )}

      {dialog?.kind === "add" && (
        <Dialog title={d.addHeading} onClose={closeDialog}>
          <p className={styles.hint}>{d.addHint}</p>
          <dl className={styles.paths}>
            <dt>{d.folder}</dt>
            <dd className={styles.mono}>{dialog.path}</dd>
          </dl>
          <ImportChoice
            legend={d.existingHeading}
            onlyNew={dialog.onlyNew}
            onChange={(onlyNew) => setDialog({ ...dialog, onlyNew })}
            disabled={dialogBusy}
          />
          <fieldset className={styles.controls} disabled={dialogBusy}>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={dialog.recursive}
                onChange={(event) => setDialog({ ...dialog, recursive: event.target.checked })}
              />
              <span>{d.recursive}</span>
            </label>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={dialog.pollOnly}
                onChange={(event) => setDialog({ ...dialog, pollOnly: event.target.checked })}
              />
              <span>
                {d.pollOnly}
                <br />
                <span className={styles.hint}>{d.pollOnlyHint}</span>
              </span>
            </label>
          </fieldset>
          {dialogError && <p className={styles.error}>{d.addFailed(dialogError)}</p>}
          <div className={styles.dialogActions}>
            <button type="button" className={styles.secondary} disabled={dialogBusy} onClick={closeDialog}>
              {d.cancel}
            </button>
            <button type="button" className={styles.button} disabled={dialogBusy} onClick={() => void confirmDialog()}>
              {dialogBusy ? d.adding : d.addConfirm}
            </button>
          </div>
        </Dialog>
      )}

      {dialog?.kind === "move" && (
        <Dialog title={d.moveHeading} onClose={closeDialog}>
          <dl className={styles.paths}>
            <dt>{d.moveFrom}</dt>
            <dd className={styles.mono}>{dialog.source.path}</dd>
            <dt>{d.moveTo}</dt>
            <dd className={styles.mono}>{dialog.path}</dd>
          </dl>
          <p className={styles.body}>{d.moveBody}</p>
          <ImportChoice
            legend={d.existingHeading}
            onlyNew={dialog.onlyNew}
            onChange={(onlyNew) => setDialog({ ...dialog, onlyNew })}
            disabled={dialogBusy}
          />
          {dialogError && <p className={styles.error}>{d.actionFailed(dialogError)}</p>}
          <div className={styles.dialogActions}>
            <button type="button" className={styles.secondary} disabled={dialogBusy} onClick={closeDialog}>
              {d.cancel}
            </button>
            <button type="button" className={styles.button} disabled={dialogBusy} onClick={() => void confirmDialog()}>
              {dialogBusy ? d.moving : d.moveConfirm}
            </button>
          </div>
        </Dialog>
      )}

      {dialog?.kind === "remove" && (
        <Dialog title={d.removeHeading} onClose={closeDialog}>
          <p className={styles.mono}>{dialog.source.path}</p>
          <p className={styles.body}>{d.removeBody(dialog.source.hands)}</p>
          {dialogError && <p className={styles.error}>{d.actionFailed(dialogError)}</p>}
          <div className={styles.dialogActions}>
            <button type="button" className={styles.secondary} disabled={dialogBusy} onClick={closeDialog}>
              {d.cancel}
            </button>
            <button
              type="button"
              className={styles.dangerSolid}
              disabled={dialogBusy}
              onClick={() => void confirmDialog()}
            >
              {dialogBusy ? d.removing : d.removeConfirm}
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
