/**
 * The HUD screen's editor (docs/RAIL-PLAN.md R3.9; guideline §7: "a visual
 * editor: drag-and-drop statistics, presets for cash, MTT and Spin, layouts
 * per room and number of seats"). Where each design is used is the HUD
 * screen's other view (At the tables).
 *
 * - **The design bar**: the presets and the user's own designs (an amber
 *   dot after the name while there are edits not saved), the game it is
 *   made for, a ⋯ menu (Rename, Duplicate, Reset to its preset, Delete),
 *   Discard and Save. A preset is never changed: the first edit of one
 *   makes the user's own copy of it (nothing is greyed out). A design is
 *   saved whole (`hud_design_save`) - refused, with why, when it is broken
 *   or a room it is used on would refuse it. A copy of a game's preset
 *   saved for the first time takes the preset's place at that game's
 *   tables, unless the user already chose another there.
 * - **Panel** (`PanelEditor`): the panel's grid - rows and columns, empty
 *   slots included - and its options; a cell's settings open in a popover
 *   by the cell (`CellSettings`), from the panel or from a number on the
 *   preview.
 * - **Preview** (`Preview`): the design drawn by the HUD's own renderer
 *   under the room picked; its panels are dragged to where the HUD puts
 *   them at real tables. **Popup** (`PopupEditor`): drawn as at the table.
 * - **Statistics** (`StatLibrary`): a drawer on the right, dragged onto the
 *   panel or into the popup.
 *
 * Nothing is computed here (guideline §14): checks, preview and the
 * resolution of assignments are the Rust side's. A sync that brings another
 * computer's rows reloads the editor (`hud-layouts-changed`).
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Dialog } from "@rail/ui/dialog/Dialog";
import { Icon } from "@rail/ui/icon/Icon";

import { StateMessage } from "../../components/StateMessage";
import { useLocale, useT } from "../../i18n";
import {
  errorText,
  inApp,
  ipc,
  onHudLayoutsChanged,
  type GameFormat,
  type HudCheck,
  type HudDesign,
  type HudEditorState,
  type HudSaved,
} from "../../lib/ipc";
import { CellSettings } from "./CellSettings";
import { DragProvider } from "./drag";
import { slotOfStat } from "./grid";
import { PanelEditor, panelActions } from "./PanelEditor";
import { PopupEditor } from "./PopupEditor";
import { Preview } from "./Preview";
import { problemText, statLabel } from "./problems";
import { StatLibrary } from "./StatLibrary";
import styles from "./HudEditor.module.css";

/** What is being edited: a preset (as shipped), a saved design, or a new one. */
type Selection = { kind: "preset"; id: string } | { kind: "user"; id: string } | { kind: "new" };

/** The cell whose settings are open, and what they are anchored to. */
interface OpenCell {
  stat: string;
  anchor: Element;
}

const FORMATS: readonly GameFormat[] = ["cash", "mtt", "spin"];
/** How long edits pause before the draft is checked against the rooms. */
const CHECK_DEBOUNCE_MS = 200;

const key = (selection: Selection) => (selection.kind === "new" ? "new" : `${selection.kind}:${selection.id}`);

export function HudEditor() {
  const t = useT();
  const h = t.hudEditor;
  const locale = useLocale();
  const id = useId();
  const [state, setState] = useState<HudEditorState | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [selection, setSelection] = useState<Selection>({ kind: "preset", id: "cash" });
  /** The edits not saved yet; `null`: the selection as stored. */
  const [draft, setDraft] = useState<HudDesign | null>(null);
  const [check, setCheck] = useState<HudCheck | null>(null);
  const [cell, setCell] = useState<OpenCell | null>(null);
  const [saved, setSaved] = useState<HudSaved | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<"rename" | "delete" | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [room, setRoom] = useState("pokerstars");
  const [size, setSize] = useState(6);

  const reload = () => setGeneration((n) => n + 1);
  useEffect(() => onHudLayoutsChanged(() => setGeneration((n) => n + 1)), []);
  useEffect(() => {
    if (!inApp) return;
    let live = true;
    ipc
      .hudEditorState()
      .then((value) => {
        if (!live) return;
        setState(value);
        setFailed(null);
      })
      .catch((reason: unknown) => {
        if (live) setFailed(errorText(reason));
      });
    return () => {
      live = false;
    };
  }, [generation]);

  const preset = selection.kind === "preset" ? state?.presets.find((p) => p.id === selection.id) : undefined;
  const user = selection.kind === "user" ? state?.designs.find((d) => d.id === selection.id) : undefined;
  const stored: HudDesign | null = preset?.design ?? user?.design ?? null;
  const design = draft ?? stored;

  // The draft against every room, as it is edited.
  useEffect(() => {
    if (!inApp || draft === null) return;
    let live = true;
    const timer = window.setTimeout(() => {
      ipc
        .hudDesignCheck(draft)
        .then((value) => {
          if (live) setCheck(value);
        })
        .catch(() => undefined);
    }, CHECK_DEBOUNCE_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [draft]);

  if (failed !== null) {
    return (
      <StateMessage kind="error" compact>
        {h.failed(failed)}
      </StateMessage>
    );
  }
  if (state === null || design === null) {
    return (
      <StateMessage kind="loading" compact>
        {h.loading}
      </StateMessage>
    );
  }

  const shownCheck: HudCheck | undefined =
    draft !== null ? (check ?? undefined) : selection.kind === "new" ? undefined : state.checks[selection.id];
  const label = statLabel(state.stats, locale);
  const presetOf = (presetId: string | undefined) => state.presets.find((p) => p.id === presetId);
  const basePreset = presetOf(design.preset);

  const select = (next: Selection) => {
    setSelection(next);
    setDraft(null);
    setCheck(null);
    setCell(null);
    setSaved(null);
  };
  /** An edit; the first edit of a preset makes the user's own copy of it (a name given is kept). */
  const edit = (next: HudDesign) => {
    if (selection.kind === "preset" && preset) {
      setSelection({ kind: "new" });
      const named = next.name !== preset.design.name && next.name.trim() !== "";
      setDraft({ ...next, name: named ? next.name : h.copyOf(preset.name[locale]), preset: preset.id });
      setAnnouncement(h.editingCopy(preset.name[locale]));
    } else {
      setDraft(next);
    }
    setSaved(null);
  };
  /** A new design from `source`, named `name`. */
  const startFrom = (source: HudDesign, name: string, presetId: string | undefined) => {
    setSelection({ kind: "new" });
    setDraft({ ...structuredClone(source), name, preset: presetId });
    setCheck(null);
    setCell(null);
    setSaved(null);
    setAnnouncement(h.editingNew(name));
  };

  const save = () => {
    const userId = selection.kind === "user" ? selection.id : null;
    const format = design.format;
    // A copy of the game's preset, saved for the first time, takes the
    // preset's place at that game's tables - unless another was chosen.
    const takesOver =
      userId === null &&
      design.preset !== undefined &&
      state.defaults[format] === design.preset &&
      !state.assignments.some((a) => a.site === "*" && a.size === null && a.format === format);
    setBusy(true);
    ipc
      .hudDesignSave(userId, design)
      .then(async (answer) => {
        if (answer.id === null) {
          setSaved(answer);
          setAnnouncement(h.notSaved);
          return;
        }
        let words = h.saved;
        if (takesOver) {
          const assigned = await ipc.hudAssign("*", null, format, answer.id).catch(() => null);
          if (assigned?.ok) words = h.savedUsed(h.gameRows[format]);
        }
        const next = await ipc.hudEditorState();
        setState(next);
        setSelection({ kind: "user", id: answer.id });
        setDraft(null);
        setCheck(null);
        setCell(null);
        setSaved(answer);
        setAnnouncement(words);
      })
      .catch((reason: unknown) => setFailed(errorText(reason)))
      .finally(() => setBusy(false));
  };

  const remove = () => {
    if (selection.kind !== "user") return;
    setBusy(true);
    ipc
      .hudDesignDelete(selection.id)
      .then(() => {
        setDialog(null);
        select({ kind: "preset", id: state.defaults[design.format] ?? "cash" });
        setAnnouncement(h.deleted);
        reload();
      })
      .catch((reason: unknown) => setFailed(errorText(reason)))
      .finally(() => setBusy(false));
  };

  const discard = () => {
    if (selection.kind === "new") select({ kind: "preset", id: design.preset ?? "cash" });
    else select(selection);
    setAnnouncement(h.discarded);
  };

  const shownName = preset ? h.presetName(preset.name[locale]) : design.name || h.untitled;
  const baseName = preset ? preset.name[locale] : design.name || h.untitled;
  const menu: MenuItem[] = [
    { label: h.rename, onSelect: () => setDialog("rename") },
    { label: h.duplicate, onSelect: () => startFrom(design, h.copyOf(baseName), design.preset ?? preset?.id) },
    ...(selection.kind !== "preset" && basePreset
      ? [
          {
            label: h.resetToPreset(basePreset.name[locale]),
            onSelect: () => edit({ ...structuredClone(basePreset.design), name: design.name, preset: basePreset.id }),
          },
        ]
      : []),
    ...(selection.kind === "user"
      ? [{ label: h.deleteMenu, onSelect: () => setDialog("delete"), danger: true, separated: true }]
      : []),
  ];

  const actions = panelActions(design, state.limits, label, edit, setAnnouncement, h);
  const openCell = cell !== null && slotOfStat(design, cell.stat) >= 0 ? cell : null;
  const openCellAt = (stat: string, anchor: Element) =>
    setCell((now) => (now?.stat === stat && now.anchor === anchor ? null : { stat, anchor }));

  return (
    <DragProvider>
      <div className={styles.editor}>
        <p className={styles.visuallyHidden} role="status" aria-live="polite">
          {announcement}
        </p>

        <section className={styles.designBar} aria-label={h.designs}>
          <div className={styles.barRow}>
            <div className={styles.designPick}>
              <select
                className={styles.designSelect}
                aria-label={h.designPicker}
                aria-describedby={draft !== null ? `${id}-unsaved` : undefined}
                value={key(selection)}
                onChange={(event) => {
                  const [kind, ...rest] = event.target.value.split(":");
                  const picked = rest.join(":");
                  if (kind === "preset" || kind === "user") select({ kind, id: picked });
                  if (kind === "copy") {
                    const source = presetOf(picked);
                    if (source) startFrom(source.design, h.copyOf(source.name[locale]), source.id);
                  }
                }}
              >
                {selection.kind === "new" ? <option value="new">{shownName}</option> : null}
                <optgroup label={h.presetsGroup}>
                  {state.presets.map((p) => (
                    <option key={p.id} value={`preset:${p.id}`}>
                      {h.presetName(p.name[locale])}
                    </option>
                  ))}
                </optgroup>
                {state.designs.length > 0 ? (
                  <optgroup label={h.yoursGroup}>
                    {state.designs.map((d) => (
                      <option key={d.id} value={`user:${d.id}`}>
                        {selection.kind === "user" && selection.id === d.id ? shownName : d.design.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                <optgroup label={h.newGroup}>
                  {state.presets.map((p) => (
                    <option key={p.id} value={`copy:${p.id}`}>
                      {h.newFromOption(p.name[locale])}
                    </option>
                  ))}
                </optgroup>
              </select>
              {draft !== null ? (
                <>
                  <span className={styles.designMirror} aria-hidden="true">
                    {shownName}
                    <span className={styles.unsavedDot} />
                  </span>
                  <span id={`${id}-unsaved`} className={styles.visuallyHidden}>
                    {h.unsaved}
                  </span>
                </>
              ) : null}
            </div>
            <div className={styles.pills} role="radiogroup" aria-label={h.format}>
              {FORMATS.map((format) => (
                <button
                  key={format}
                  type="button"
                  role="radio"
                  aria-checked={design.format === format}
                  className={`chip-btn${design.format === format ? " is-active" : ""}`}
                  onClick={() => {
                    if (design.format !== format) edit({ ...design, format });
                  }}
                >
                  {h.formats[format]}
                </button>
              ))}
            </div>
            <div className={styles.barActions}>
              <Menu label={h.designMenu} items={menu} />
              {draft !== null ? (
                <button type="button" className="btn btn--ghost" onClick={discard}>
                  {h.discard}
                </button>
              ) : null}
              <button type="button" className="btn btn--primary" disabled={busy || draft === null} onClick={save}>
                {busy ? h.saving : h.save}
              </button>
            </div>
          </div>
          {shownCheck && shownCheck.problems.length > 0 ? (
            <ul className={styles.barProblems}>
              {shownCheck.problems.map((problem, index) => (
                <li key={index}>{problemText(problem, h.problems, label)}</li>
              ))}
            </ul>
          ) : null}
          {saved && saved.id === null ? (
            <div className={styles.refusedBox} role="alert">
              <p>{h.notSaved}</p>
              <ul className={styles.problemList}>
                {saved.problems.map((problem, index) => (
                  <li key={index}>{problemText(problem, h.problems, label)}</li>
                ))}
                {Object.entries(saved.refused).flatMap(([site, list]) =>
                  list.map((problem, index) => (
                    <li key={`${site}-${index}`}>
                      {`${state.rooms.find((r) => r.id === site)?.name ?? site}: ${problemText(problem, h.problems, label)}`}
                    </li>
                  )),
                )}
              </ul>
            </div>
          ) : null}
        </section>

        <div className={styles.workspace}>
          <div className={styles.mainColumn}>
            <section className={styles.card} aria-label={h.panel}>
              <PanelEditor
                design={design}
                state={state}
                selected={openCell?.stat ?? null}
                label={label}
                actions={actions}
                onOpenCell={openCellAt}
                onChange={edit}
                announce={setAnnouncement}
              />
            </section>
            <section className={styles.card} aria-label={h.preview}>
              <Preview
                design={design}
                state={state}
                room={state.rooms.some((r) => r.id === room) ? room : (state.rooms[0]?.id ?? room)}
                size={size}
                selected={openCell?.stat ?? null}
                onRoom={setRoom}
                onSize={setSize}
                onOpenCell={openCellAt}
                onChanged={reload}
                announce={setAnnouncement}
              />
            </section>
            <section className={styles.card} aria-label={h.popup}>
              <PopupEditor design={design} state={state} onChange={edit} announce={setAnnouncement} />
            </section>
          </div>
          <aside className={styles.drawer} aria-label={h.palette}>
            <StatLibrary stats={state.stats} onPanel={actions.onPanel} full={actions.full} onAdd={actions.add} />
          </aside>
        </div>

        {openCell ? (
          <CellSettings
            key={openCell.stat}
            anchor={openCell.anchor}
            cell={design.cells[slotOfStat(design, openCell.stat)] ?? { stat: openCell.stat }}
            stat={state.stats.find((s) => s.id === openCell.stat)}
            override={design.overrides?.[openCell.stat] ?? {}}
            maxDecimals={state.limits.maxDecimals}
            onClose={() => setCell(null)}
            onRemove={() => {
              actions.remove(openCell.stat);
              setCell(null);
            }}
            onCell={(next) => {
              const at = slotOfStat(design, openCell.stat);
              edit({ ...design, cells: design.cells.map((c, i) => (i === at ? next : c)) });
            }}
            onOverride={(next) => {
              const overrides = { ...(design.overrides ?? {}) };
              if (next.bands === undefined && next.decimals === undefined && next.minSample === undefined) {
                delete overrides[openCell.stat];
              } else {
                overrides[openCell.stat] = next;
              }
              edit({ ...design, overrides });
            }}
          />
        ) : null}

        {dialog === "rename" ? (
          <RenameDialog
            name={preset ? h.copyOf(preset.name[locale]) : design.name}
            onClose={() => setDialog(null)}
            onRename={(name) => {
              setDialog(null);
              edit({ ...design, name });
              setAnnouncement(h.renamed(name));
            }}
          />
        ) : null}
        {dialog === "delete" ? (
          <Dialog title={h.delete} onClose={() => setDialog(null)}>
            <p>{h.deleteConfirm(design.name)}</p>
            <div className={styles.dialogActions}>
              <button type="button" className="btn" disabled={busy} onClick={() => setDialog(null)}>
                {h.cancel}
              </button>
              <button type="button" className="btn btn--primary" disabled={busy} onClick={remove}>
                {h.deleteYes}
              </button>
            </div>
          </Dialog>
        ) : null}
      </div>
    </DragProvider>
  );
}

function RenameDialog({ name, onClose, onRename }: { name: string; onClose: () => void; onRename: (name: string) => void }) {
  const h = useT().hudEditor;
  const [value, setValue] = useState(name);
  const trimmed = value.trim();
  return (
    <Dialog title={h.renameTitle} onClose={onClose}>
      <form
        className={styles.renameForm}
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed !== "") onRename(trimmed);
        }}
      >
        <input
          autoFocus
          className={styles.input}
          aria-label={h.name}
          value={value}
          maxLength={60}
          onChange={(event) => setValue(event.target.value)}
        />
        <div className={styles.dialogActions}>
          <button type="button" className="btn" onClick={onClose}>
            {h.cancel}
          </button>
          <button type="submit" className="btn btn--primary" disabled={trimmed === ""}>
            {h.renameYes}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  /** A line above it. */
  separated?: boolean;
}

/** A ⋯ button and its small menu; Escape or a click elsewhere closes it, ↑ / ↓ move between the items. */
function Menu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    wrap.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    const onDown = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const all = [...(wrap.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [])];
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? (at + 1) % all.length : (at - 1 + all.length) % all.length;
    all[next]?.focus();
  };

  return (
    <div ref={wrap} className={styles.menuWrap}>
      <button
        ref={button}
        type="button"
        className={styles.moreButton}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((was) => !was)}
      >
        <Icon name="more" />
      </button>
      {open ? (
        <div id={menuId} role="menu" className={styles.menu} onKeyDown={onMenuKey}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={[styles.menuItem, item.danger ? styles.menuDanger : "", item.separated ? styles.menuSeparated : ""].join(" ")}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
