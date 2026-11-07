/**
 * Settings, Hand histories (R1.5; guideline §3 "Upravljanje mapama"): one
 * card of rows - "Folders" with Find folders and Add a folder…, then a row
 * per watched folder: its room, its path, its refused hands as a pill that
 * opens them, and a ⋯ menu (edit, remove). Editing (the path, the room,
 * watch / subfolders / polling) is a dialog; a backfill in progress shows
 * under its row (R1.6). The list is `watcher_status`, refreshed when the
 * app reports a change (`useWatcherStatus`); every change goes through the
 * commands in `folder_settings.rs`.
 */
import { Dialog } from "@rail/ui/dialog/Dialog";
import { Icon } from "@rail/ui/icon/Icon";
import { RailLoader } from "@rail/ui/loader/RailLoader";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { BackfillProgress } from "../../components/BackfillProgress";
import { ImportChoice } from "../../components/ImportChoice";
import { useT } from "../../i18n";
import { errorText, ipc, type FoundFolder, type RoomChoice, type WatchSource } from "../../lib/ipc";
import { go, REFUSED, screenHref, SETUP } from "../../lib/router";
import { useWatcherStatus } from "../../lib/useWatcherStatus";
import styles from "./Folders.module.css";
import s from "./Settings.module.css";
import { Toggle } from "./Toggle";

interface Notice {
  text: string;
  error: boolean;
}

type DialogState =
  | { kind: "add"; path: string; onlyNew: boolean; recursive: boolean; pollOnly: boolean }
  | { kind: "edit"; id: number }
  | { kind: "move"; source: WatchSource; path: string; onlyNew: boolean }
  | { kind: "remove"; source: WatchSource };

type Search =
  | { phase: "searching" }
  | { phase: "failed"; reason: string }
  | { phase: "shown"; folders: FoundFolder[]; adding: string | null };

/** The room a folder is read as: chosen by hand, found by Rail, or detected per file. */
function roomName(source: WatchSource, rooms: RoomChoice[], auto: string): string {
  if (source.siteOverride) {
    return rooms.find((room) => room.parser === source.siteOverride)?.name ?? source.siteOverride;
  }
  return source.siteName ?? auto;
}

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
    if (!dialog || dialog.kind === "edit") {
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

  const find = async () => {
    setSearch({ phase: "searching" });
    try {
      const discovery = await ipc.discoverFolders();
      setSearch({ phase: "shown", folders: discovery.folders.filter((found) => !found.watched), adding: null });
    } catch (e: unknown) {
      setSearch({ phase: "failed", reason: errorText(e) });
    }
  };

  /** Watch one folder Rail found, with the hands already in it. */
  const watchFound = async (found: FoundFolder) => {
    if (search?.phase !== "shown") {
      return;
    }
    setSearch({ ...search, adding: found.path });
    try {
      const added = await ipc.addFolders([{ path: found.path, site: found.site }], false);
      setNotice({ text: d.search.added(added.length), error: false });
      setSearch({ ...search, folders: search.folders.filter((row) => row.path !== found.path), adding: null });
      load();
    } catch (e: unknown) {
      setSearch({ ...search, adding: null });
      setNotice({ text: d.addFailed(errorText(e)), error: true });
    }
  };

  const saved = async (step: Promise<unknown>) => {
    await step;
    return d.saved;
  };

  const failure = loadError ?? (status && !status.running ? status.error : null);
  const editing = dialog?.kind === "edit" ? (status?.sources.find((source) => source.id === dialog.id) ?? null) : null;

  return (
    <>
      <div className={s.card}>
        <div className={`${s.row} ${s.rowWide}`}>
          <span className={s.strong}>{d.foldersRow}</span>
          <span className={s.actions}>
            <button
              type="button"
              className="btn btn--sm"
              disabled={search?.phase === "searching"}
              onClick={() => void find()}
            >
              {d.find}
            </button>
            <button type="button" className="btn btn--primary btn--sm" disabled={picking} onClick={() => void add()}>
              {picking ? d.choosing : d.add}
            </button>
          </span>
        </div>

        {failure !== null && (
          <div className={`${s.row} ${s.rowWide}`}>
            <p className={s.error}>{loadError ? d.loadFailed(failure) : d.notRunning(failure)}</p>
          </div>
        )}
        {!status && failure === null && (
          <div className={`${s.row} ${s.rowWide}`}>
            <RailLoader size="inline" label={d.loading} showLabel />
          </div>
        )}
        {status && status.sources.length === 0 && failure === null && (
          <div className={`${s.row} ${s.rowWide}`}>
            <p className={s.muted}>{d.empty}</p>
          </div>
        )}
        {status && status.sources.length > 0 && (
          <div className={styles.rows} role="list" aria-label={d.list}>
            {status.sources.map((source) => (
              <FolderRow
                key={source.id}
                source={source}
                room={roomName(source, rooms, d.roomAuto)}
                onEdit={() => openDialog({ kind: "edit", id: source.id })}
                onRemove={() => openDialog({ kind: "remove", source })}
              />
            ))}
          </div>
        )}
      </div>

      <div className={s.live} aria-live="polite">
        {notice && <p className={`${s.note} ${notice.error ? s.error : ""}`}>{notice.text}</p>}
      </div>

      {search && (
        <div className={s.card} aria-label={d.search.heading} role="group">
          <div className={`${s.row} ${s.rowWide}`}>
            <span className={s.strong}>{d.search.heading}</span>
            <span className={s.actions}>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setSearch(null)}>
                {d.search.close}
              </button>
            </span>
          </div>
          {search.phase === "searching" && (
            <div className={`${s.row} ${s.rowWide}`}>
              <RailLoader size="inline" label={d.search.searching} showLabel />
            </div>
          )}
          {search.phase === "failed" && (
            <div className={`${s.row} ${s.rowWide}`}>
              <p className={s.error}>{d.search.failed(search.reason)}</p>
            </div>
          )}
          {search.phase === "shown" && search.folders.length === 0 && (
            <div className={`${s.row} ${s.rowWide}`}>
              <p className={s.muted}>
                {d.search.noneNew}{" "}
                <a href={screenHref(SETUP)}>{d.setup}</a>
              </p>
            </div>
          )}
          {search.phase === "shown" &&
            search.folders.map((found) => (
              <div key={found.path} className={s.row}>
                <span className={styles.room}>{found.name}</span>
                <span className={s.mono} title={found.path}>
                  {found.path}
                </span>
                <span className={s.actions}>
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    disabled={search.adding !== null}
                    onClick={() => void watchFound(found)}
                  >
                    {search.adding === found.path ? d.search.adding : d.search.watch}
                  </button>
                </span>
              </div>
            ))}
        </div>
      )}

      {dialog?.kind === "edit" && editing && (
        <EditFolder
          source={editing}
          rooms={rooms}
          busy={busyId === editing.id}
          onClose={() => setDialog(null)}
          onChangePath={() => void changePath(editing)}
          setEnabled={(on) => void change(editing.id, () => saved(ipc.setFolderEnabled(editing.id, on)))}
          setRecursive={(on) => void change(editing.id, () => saved(ipc.setFolderRecursive(editing.id, on)))}
          setPollOnly={(on) => void change(editing.id, () => saved(ipc.setFolderPollOnly(editing.id, on)))}
          setRoom={(parser) =>
            void change(editing.id, async () => d.roomSaved(await ipc.setFolderRoom(editing.id, parser)))
          }
        />
      )}

      {dialog?.kind === "add" && (
        <Dialog title={d.addHeading} onClose={closeDialog}>
          <p className={styles.hint}>{d.addHint}</p>
          <dl className={styles.paths}>
            <dt>{d.folder}</dt>
            <dd>{dialog.path}</dd>
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
            <dd>{dialog.source.path}</dd>
            <dt>{d.moveTo}</dt>
            <dd>{dialog.path}</dd>
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
    </>
  );
}

/**
 * One watched folder: its room and path (muted with "Not watched" when
 * switched off), its state when it cannot be read, its refused hands as a
 * pill that opens them, and the ⋯ menu; a backfill in progress under it.
 */
function FolderRow({
  source,
  room,
  onEdit,
  onRemove,
}: {
  source: WatchSource;
  room: string;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const d = t.settings.folders;
  const off = !source.enabled;
  const bad = source.state === "unavailable" || source.state === "error";
  return (
    <div role="listitem">
      <div className={s.row}>
        <span className={`${styles.room} ${off ? s.dim : ""}`}>{room}</span>
        <span className={`${s.mono} ${off ? s.dim : ""}`} title={source.path}>
          {source.path}
        </span>
        <span className={s.actions}>
          {off && <span className={s.muted}>{d.notWatched}</span>}
          {bad && (
            <span className={s.error} title={source.error ?? undefined}>
              {t.watch.states[source.state]}
            </span>
          )}
          {source.quarantined > 0 && (
            <button
              type="button"
              className={s.pill}
              aria-label={d.refusedHeading(source.path)}
              onClick={() => go(REFUSED, String(source.id))}
            >
              {d.refusedPill(source.quarantined)}
            </button>
          )}
          <RowMenu
            label={d.more(source.path)}
            items={[
              { label: d.edit, onSelect: onEdit },
              { label: d.remove, onSelect: onRemove, danger: true },
            ]}
          />
        </span>
      </div>
      {source.backfill && (
        <div className={styles.backfill}>
          <BackfillProgress backfill={source.backfill} label={t.backfill.of(source.path)} />
        </div>
      )}
    </div>
  );
}

/** A ⋯ button and its small menu; Escape or a click elsewhere closes it. */
function RowMenu({
  label,
  items,
}: {
  label: string;
  items: { label: string; onSelect: () => void; danger?: boolean }[];
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    wrap.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    const onDown = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  /** ↑ / ↓ move between the items. */
  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const all = [...(wrap.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [])];
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? (at + 1) % all.length : (at - 1 + all.length) % all.length;
    all[next]?.focus();
  };

  return (
    <div ref={wrap} className={s.menuWrap}>
      <button
        ref={button}
        type="button"
        className={s.iconButton}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((was) => !was)}
      >
        <Icon name="more" />
      </button>
      {open && (
        <div id={menuId} role="menu" className={s.menu} onKeyDown={onMenuKey}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={`${s.menuItem} ${item.danger ? s.menuDanger : ""}`}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A folder's settings (what the folder card used to hold): its path and
 * "Change…", the room it is read as, and watch / subfolders / polling.
 * Each change is saved at once.
 */
function EditFolder({
  source,
  rooms,
  busy,
  onClose,
  onChangePath,
  setEnabled,
  setRecursive,
  setPollOnly,
  setRoom,
}: {
  source: WatchSource;
  rooms: RoomChoice[];
  busy: boolean;
  onClose: () => void;
  onChangePath: () => void;
  setEnabled: (enabled: boolean) => void;
  setRecursive: (recursive: boolean) => void;
  setPollOnly: (pollOnly: boolean) => void;
  setRoom: (parser: string | null) => void;
}) {
  const d = useT().settings.folders;
  const id = useId();
  const roomOptions =
    source.siteOverride && !rooms.some((choice) => choice.parser === source.siteOverride)
      ? [...rooms, { parser: source.siteOverride, name: source.siteOverride }]
      : rooms;
  return (
    <Dialog title={d.editHeading} onClose={onClose}>
      <div className={styles.setting}>
        <span className={styles.mono}>{source.path}</span>
        <button type="button" className="btn btn--sm" onClick={onChangePath}>
          {d.change}
        </button>
      </div>
      <fieldset className={styles.controls} disabled={busy} aria-label={d.settingsOf(source.path)}>
        <div className={styles.setting}>
          <label htmlFor={`${id}-room`}>{d.room}</label>
          <select
            id={`${id}-room`}
            className={styles.select}
            value={source.siteOverride ?? ""}
            onChange={(event) => setRoom(event.target.value === "" ? null : event.target.value)}
          >
            <option value="">{d.roomAuto}</option>
            {roomOptions.map((choice) => (
              <option key={choice.parser} value={choice.parser}>
                {choice.name}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.setting}>
          <label htmlFor={`${id}-enabled`}>{d.enabled}</label>
          <Toggle id={`${id}-enabled`} checked={source.enabled} onChange={setEnabled} />
        </div>
        <div className={styles.setting}>
          <label htmlFor={`${id}-recursive`}>{d.recursive}</label>
          <Toggle id={`${id}-recursive`} checked={source.recursive} onChange={setRecursive} />
        </div>
        <div className={styles.setting}>
          <label htmlFor={`${id}-poll`}>{d.pollOnly}</label>
          <Toggle id={`${id}-poll`} checked={source.pollOnly} onChange={setPollOnly} />
        </div>
      </fieldset>
      <div className={styles.dialogActions}>
        <button type="button" className={styles.button} onClick={onClose}>
          {d.done}
        </button>
      </div>
    </Dialog>
  );
}
