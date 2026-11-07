/**
 * The HUD screen's editor (docs/RAIL-PLAN.md R3.9; guideline §7: "a visual
 * editor: drag-and-drop statistics, presets for cash, MTT and Spin, layouts
 * per room and number of seats").
 *
 * Top to bottom, in the order a design is made:
 *
 * - **The design bar**: the presets and the user's own designs, its name,
 *   what it is made for, Save. A preset is never changed: the first edit
 *   of one makes the user's own copy of it (nothing is greyed out). A
 *   design is saved whole (`hud_design_save`) - refused, with why, when it
 *   is broken or a room it is used on would refuse it. A copy of a game's
 *   preset saved for the first time takes the preset's place at that
 *   game's tables, unless the user already chose another there. As the
 *   draft is edited, the Rust side checks it against every allowed room
 *   (`hud_design_check`); the bar says per room whether it may be used.
 * - **Panel** (`PanelEditor`): the cells as the HUD lays them out, and the
 *   settings of the cell picked; **statistics** (`StatLibrary`) are
 *   dragged onto it or into the popup.
 * - **Preview** (`Preview`): the design drawn by the HUD's own renderer
 *   under the room picked; its panels are dragged to where the HUD puts
 *   them at real tables. **Popup** (`PopupEditor`): its sections.
 * - **Tables** (`Assignments`): which design each game, room and size gets.
 *
 * The HUD's status and where it may be used are under it (`HudStatusPanel`). Nothing
 * is computed here (guideline §14): checks, preview and the resolution of
 * assignments are the Rust side's. A sync that brings another computer's
 * rows reloads the screen (`hud-layouts-changed`).
 */
import { useEffect, useId, useState } from "react";
import { Dialog } from "@rail/ui/dialog/Dialog";

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
import { Assignments } from "./Assignments";
import { DragProvider } from "./drag";
import { PanelEditor, panelActions } from "./PanelEditor";
import { PopupEditor } from "./PopupEditor";
import { Preview } from "./Preview";
import { isNote, problemText, statLabel } from "./problems";
import { StatLibrary } from "./StatLibrary";
import styles from "./HudEditor.module.css";

/** What is being edited: a preset (as shipped), a saved design, or a new one. */
type Selection = { kind: "preset"; id: string } | { kind: "user"; id: string } | { kind: "new" };

const FORMATS: readonly GameFormat[] = ["cash", "mtt", "spin"];
/** How long edits pause before the draft is checked against the rooms. */
const CHECK_DEBOUNCE_MS = 200;

const key = (selection: Selection) => (selection.kind === "new" ? "new" : `${selection.kind}:${selection.id}`);

export function HudEditor() {
  const t = useT();
  const h = t.hudEditor;
  const locale = useLocale();
  const nameId = useId();
  const [state, setState] = useState<HudEditorState | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [selection, setSelection] = useState<Selection>({ kind: "preset", id: "cash" });
  /** The edits not saved yet; `null`: the selection as stored. */
  const [draft, setDraft] = useState<HudDesign | null>(null);
  const [check, setCheck] = useState<HudCheck | null>(null);
  const [cell, setCell] = useState<number | null>(null);
  const [saved, setSaved] = useState<HudSaved | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
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
  const presetOf = (id: string | undefined) => state.presets.find((p) => p.id === id);
  const basePreset = presetOf(design.preset);

  const select = (next: Selection) => {
    setSelection(next);
    setDraft(null);
    setCheck(null);
    setCell(null);
    setSaved(null);
    setNotice(null);
  };
  /** An edit; the first edit of a preset makes the user's own copy of it. */
  const edit = (next: HudDesign) => {
    if (selection.kind === "preset" && preset) {
      setSelection({ kind: "new" });
      setDraft({ ...next, name: h.copyOf(preset.name[locale]), preset: preset.id });
      setAnnouncement(h.editingCopy(preset.name[locale]));
    } else {
      setDraft(next);
    }
    setSaved(null);
    setNotice(null);
  };
  const copyFrom = (id: string) => {
    const source = presetOf(id);
    if (!source) return;
    setSelection({ kind: "new" });
    setDraft({ ...structuredClone(source.design), name: h.copyOf(source.name[locale]), preset: source.id });
    setCheck(null);
    setCell(null);
    setSaved(null);
    setNotice(null);
  };

  const save = () => {
    const id = selection.kind === "user" ? selection.id : null;
    const format = design.format;
    // A copy of the game's preset, saved for the first time, takes the
    // preset's place at that game's tables - unless another was chosen.
    const takesOver =
      id === null &&
      design.preset !== undefined &&
      state.defaults[format] === design.preset &&
      !state.assignments.some((a) => a.site === "*" && a.size === null && a.format === format);
    setBusy(true);
    ipc
      .hudDesignSave(id, design)
      .then(async (answer) => {
        if (answer.id === null) {
          setSaved(answer);
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
        setSaved(answer);
        setNotice(words);
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
        setDeleting(false);
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
  };

  const actions = panelActions(design, state.limits.maxCells, label, edit, setCell, setAnnouncement, h);
  const roomStatus = (id: string) => {
    const problems = shownCheck?.rooms[id] ?? [];
    return { problems, refused: problems.some((p) => !isNote(p)) };
  };
  const roomLines = state.rooms
    .map((r) => ({ room: r, ...roomStatus(r.id) }))
    .filter((r) => r.problems.length > 0);

  return (
    <DragProvider>
      <div className={styles.editor}>
        <p className={styles.visuallyHidden} role="status" aria-live="polite">
          {announcement}
        </p>

        <section className={styles.designBar} aria-label={h.designs}>
          <div className={styles.barRow}>
            <label className={styles.field}>
              <span className={styles.toolLabel}>{h.designPicker}</span>
              <select
                className={`${styles.input} ${styles.designSelect}`}
                value={key(selection)}
                onChange={(event) => {
                  const [kind, ...rest] = event.target.value.split(":");
                  const id = rest.join(":");
                  if (kind === "preset" || kind === "user") select({ kind, id });
                  if (kind === "copy") copyFrom(id);
                }}
              >
                {selection.kind === "new" ? <option value="new">{design.name || h.untitled}</option> : null}
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
                        {d.design.name}
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
            </label>
            {selection.kind !== "preset" ? (
              <label className={styles.field}>
                <span className={styles.toolLabel}>{h.name}</span>
                <input
                  id={nameId}
                  className={`${styles.input} ${styles.nameInput}`}
                  value={design.name}
                  maxLength={60}
                  onChange={(event) => edit({ ...design, name: event.target.value })}
                />
              </label>
            ) : null}
            <div className={styles.field}>
              <span className={styles.toolLabel} id={`${nameId}-format`}>
                {h.format}
              </span>
              <div className={styles.segmented} role="radiogroup" aria-labelledby={`${nameId}-format`}>
                {FORMATS.map((format) => (
                  <button
                    key={format}
                    type="button"
                    role="radio"
                    aria-checked={design.format === format}
                    className={design.format === format ? `${styles.segment} ${styles.segmentOn}` : styles.segment}
                    onClick={() => {
                      if (design.format !== format) edit({ ...design, format });
                    }}
                  >
                    {h.formats[format]}
                  </button>
                ))}
              </div>
            </div>
            <div className={styles.barActions}>
              {draft !== null ? <span className={styles.unsaved}>{h.unsaved}</span> : null}
              {draft !== null ? (
                <button type="button" className="btn btn--sm" onClick={discard}>
                  {h.discard}
                </button>
              ) : null}
              {selection.kind !== "preset" && basePreset ? (
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  onClick={() => edit({ ...structuredClone(basePreset.design), name: design.name, preset: basePreset.id })}
                >
                  {h.resetToPreset(basePreset.name[locale])}
                </button>
              ) : null}
              {selection.kind === "user" ? (
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => setDeleting(true)}>
                  {h.delete}
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn--primary btn--sm"
                disabled={busy || draft === null}
                onClick={save}
              >
                {busy ? h.saving : h.save}
              </button>
            </div>
          </div>

          <div className={styles.barInfo}>
            <p className={styles.barNote}>
              {preset
                ? `${preset.description[locale]} ${h.presetNote(preset.name[locale])}`
                : selection.kind === "new" && basePreset
                  ? h.copyNote(basePreset.name[locale])
                  : null}
              {notice ? <span className={styles.ok}>{notice}</span> : null}
            </p>
            {shownCheck ? (
              <ul className={styles.roomPills} aria-label={h.rooms}>
                {state.rooms.map((r) => {
                  const { problems, refused } = roomStatus(r.id);
                  const tone = refused ? styles.pillBad : problems.length > 0 ? styles.pillNote : styles.pillOk;
                  const text =
                    problems.length === 0
                      ? h.roomOk(r.name)
                      : `${refused ? h.roomRefused(r.name) : h.roomNotes(r.name)} ${problems
                          .map((p) => problemText(p, h.problems, label))
                          .join("; ")}`;
                  return (
                    <li key={r.id} className={`${styles.pill} ${tone}`} title={text}>
                      <span aria-hidden="true">{refused ? "✕" : problems.length > 0 ? "!" : "✓"}</span>
                      <span className={styles.visuallyHidden}>{text}</span>
                      <span aria-hidden="true">{r.name}</span>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
          {shownCheck && (shownCheck.problems.length > 0 || roomLines.length > 0) ? (
            <ul className={styles.barProblems}>
              {shownCheck.problems.map((problem, index) => (
                <li key={`p-${index}`} className={styles.refused}>
                  {problemText(problem, h.problems, label)}
                </li>
              ))}
              {roomLines.map(({ room: r, problems, refused }) => (
                <li key={r.id} className={refused ? styles.refused : styles.noteText}>
                  {`${refused ? h.roomRefused(r.name) : h.roomNotes(r.name)} ${problems
                    .map((p) => problemText(p, h.problems, label))
                    .join("; ")}`}
                </li>
              ))}
            </ul>
          ) : null}
          {saved && saved.id === null ? (
            <div className={styles.refusedBox} role="alert">
              <p className={styles.refused}>{h.notSaved}</p>
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

        <section className={styles.card} aria-labelledby={`${nameId}-panel`}>
          <div className={styles.cardHead}>
            <h2 id={`${nameId}-panel`} className={styles.heading}>
              {h.panel}
            </h2>
            <span className={styles.hint}>{h.cellCount(design.cells.length, state.limits.maxCells)}</span>
          </div>
          <PanelEditor
            design={design}
            state={state}
            selected={cell}
            label={label}
            onSelect={setCell}
            onChange={edit}
            announce={setAnnouncement}
            library={
              <section className={styles.librarySection} aria-label={h.palette}>
                <h3 className={styles.subheading}>{h.palette}</h3>
                <StatLibrary
                  stats={state.stats}
                  onPanel={actions.onPanel}
                  full={actions.full}
                  onAdd={(id) => actions.insert(id, design.cells.length)}
                />
              </section>
            }
          />
        </section>

        <div className={styles.split}>
          <section className={styles.card} aria-labelledby={`${nameId}-preview`}>
            <div className={styles.cardHead}>
              <h2 id={`${nameId}-preview`} className={styles.heading}>
                {h.preview}
              </h2>
            </div>
            <Preview
              design={design}
              state={state}
              room={state.rooms.some((r) => r.id === room) ? room : (state.rooms[0]?.id ?? room)}
              size={size}
              onRoom={setRoom}
              onSize={setSize}
              onChanged={reload}
              announce={setAnnouncement}
            />
          </section>
          <section className={styles.card} aria-labelledby={`${nameId}-popup`}>
            <div className={styles.cardHead}>
              <h2 id={`${nameId}-popup`} className={styles.heading}>
                {h.popup}
              </h2>
            </div>
            <PopupEditor design={design} state={state} onChange={edit} announce={setAnnouncement} />
          </section>
        </div>

        <section className={styles.card} aria-labelledby={`${nameId}-assign`}>
          <div className={styles.cardHead}>
            <h2 id={`${nameId}-assign`} className={styles.heading}>
              {h.assignments}
            </h2>
          </div>
          <Assignments state={state} onChanged={reload} />
        </section>

        {deleting ? (
          <Dialog title={h.delete} onClose={() => setDeleting(false)}>
            <p>{h.deleteConfirm(design.name)}</p>
            <div className={styles.inline}>
              <button type="button" className="btn" disabled={busy} onClick={() => setDeleting(false)}>
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
