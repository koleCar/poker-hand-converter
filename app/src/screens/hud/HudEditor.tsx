/**
 * The HUD screen's editor (docs/RAIL-PLAN.md R3.9; guideline §7: "a visual
 * editor: drag-and-drop statistics, presets for cash, MTT and Spin, layouts
 * per room and number of seats").
 *
 * - **Designs**: the presets (read-only: "make my copy" to change one) and
 *   the user's own; a design is edited here and saved whole
 *   (`hud_design_save`) - refused, with why, when it is broken or a room it
 *   is used on would refuse it. "Reset to" puts a copy back to its preset.
 * - **Panel** (`PanelEditor`): drag statistics in, reorder, per-cell
 *   settings (decimals, sample, colour bands, stack depth); **popup**
 *   (`PopupEditor`): its sections.
 * - **Rooms**: as the draft is edited, the Rust side checks it against every
 *   allowed room (`hud_design_check`) and the screen says where it may be
 *   used and why not; the **preview** (`Preview`) draws it with the HUD's
 *   own renderer under the room picked.
 * - **Assignments** (`Assignments`): which design each room, table size and
 *   game gets.
 *
 * Nothing is computed here (guideline §14): checks, preview and the
 * resolution of assignments are the Rust side's. A sync that brings another
 * computer's rows reloads the screen (`hud-layouts-changed`).
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
import { PanelEditor } from "./PanelEditor";
import { PopupEditor } from "./PopupEditor";
import { Preview } from "./Preview";
import { isNote, problemText, statLabel } from "./problems";
import styles from "./HudEditor.module.css";

/** What is being edited: a preset (read-only), a saved design, or a new one. */
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
  const [newFrom, setNewFrom] = useState("cash");
  const [saved, setSaved] = useState<HudSaved | null>(null);
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
  const editable = selection.kind !== "preset";

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
  };
  const edit = (next: HudDesign) => {
    setDraft(next);
    setSaved(null);
  };
  const copyFrom = (id: string) => {
    const source = presetOf(id);
    if (!source) return;
    setSelection({ kind: "new" });
    setDraft({ ...structuredClone(source.design), name: h.copyOf(source.name[locale]), preset: source.id });
    setCheck(null);
    setCell(null);
    setSaved(null);
  };
  const copySelected = () => {
    if (!preset) return;
    copyFrom(preset.id);
  };

  const save = () => {
    const id = selection.kind === "user" ? selection.id : null;
    setBusy(true);
    ipc
      .hudDesignSave(id, design)
      .then(async (answer) => {
        if (answer.id === null) {
          setSaved(answer);
          return;
        }
        const next = await ipc.hudEditorState();
        setState(next);
        setSelection({ kind: "user", id: answer.id });
        setDraft(null);
        setCheck(null);
        setSaved(answer);
        setAnnouncement(h.saved);
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

  return (
    <div className={styles.editor}>
      <p className={styles.visuallyHidden} role="status" aria-live="polite">
        {announcement}
      </p>

      <section className={styles.card} aria-labelledby={`${nameId}-designs`}>
        <h2 id={`${nameId}-designs`} className={styles.heading}>
          {h.designs}
        </h2>
        <div className={styles.row}>
          <label className={styles.field}>
            <span className={styles.label}>{h.designPicker}</span>
            <select
              className={styles.input}
              value={key(selection)}
              onChange={(event) => {
                const [kind, ...rest] = event.target.value.split(":");
                const id = rest.join(":");
                if (kind === "preset" || kind === "user") select({ kind, id });
              }}
            >
              {selection.kind === "new" ? <option value="new">{design.name}</option> : null}
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
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.label}>{h.newFrom}</span>
            <span className={styles.inline}>
              <select className={styles.input} value={newFrom} onChange={(event) => setNewFrom(event.target.value)}>
                {state.presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name[locale]}
                  </option>
                ))}
              </select>
              <button type="button" className="btn btn--sm" onClick={() => copyFrom(newFrom)}>
                {h.create}
              </button>
            </span>
          </label>
        </div>

        {preset ? (
          <div className={styles.presetInfo}>
            <p>{preset.description[locale]}</p>
            <p className={styles.hint}>{h.presetReadOnly}</p>
            <button type="button" className="btn btn--primary btn--sm" onClick={copySelected}>
              {h.makeCopy}
            </button>
          </div>
        ) : (
          <div className={styles.row}>
            <label className={styles.field}>
              <span className={styles.label}>{h.name}</span>
              <input
                id={nameId}
                className={styles.input}
                value={design.name}
                maxLength={60}
                onChange={(event) => edit({ ...design, name: event.target.value })}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>{h.format}</span>
              <select
                className={styles.input}
                value={design.format}
                onChange={(event) => edit({ ...design, format: event.target.value as GameFormat })}
              >
                {FORMATS.map((format) => (
                  <option key={format} value={format}>
                    {h.formats[format]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        {editable ? (
          <div className={styles.actions}>
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy || (draft === null && selection.kind === "user")}
              onClick={save}
            >
              {busy ? h.saving : h.save}
            </button>
            {draft !== null && selection.kind === "user" ? (
              <button type="button" className="btn" onClick={() => select(selection)}>
                {h.discard}
              </button>
            ) : null}
            {basePreset ? (
              <button
                type="button"
                className="btn"
                onClick={() => edit({ ...structuredClone(basePreset.design), name: design.name, preset: basePreset.id })}
              >
                {h.resetToPreset(basePreset.name[locale])}
              </button>
            ) : null}
            {selection.kind === "user" ? (
              <button type="button" className="btn" onClick={() => setDeleting(true)}>
                {h.delete}
              </button>
            ) : null}
            {draft !== null ? <span className={styles.unsaved}>{h.unsaved}</span> : null}
          </div>
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

        {shownCheck ? (
          <div className={styles.rooms}>
            <h3 className={styles.subheading}>{h.rooms}</h3>
            {shownCheck.problems.length > 0 ? (
              <ul className={styles.problemList}>
                {shownCheck.problems.map((problem, index) => (
                  <li key={index} className={styles.refused}>
                    {problemText(problem, h.problems, label)}
                  </li>
                ))}
              </ul>
            ) : null}
            <ul className={styles.roomList}>
              {state.rooms.map((r) => {
                const problems = shownCheck.rooms[r.id] ?? [];
                const refused = problems.some((p) => !isNote(p));
                return (
                  <li key={r.id} className={refused ? styles.refused : problems.length > 0 ? styles.note : styles.ok}>
                    {problems.length === 0
                      ? h.roomOk(r.name)
                      : `${refused ? h.roomRefused(r.name) : h.roomNotes(r.name)} ${problems
                          .map((p) => problemText(p, h.problems, label))
                          .join("; ")}`}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </section>

      <section className={styles.card} aria-labelledby={`${nameId}-panel`}>
        <h2 id={`${nameId}-panel`} className={styles.heading}>
          {h.panel}
        </h2>
        <PanelEditor
          design={design}
          state={state}
          editable={editable}
          selected={cell}
          onSelect={setCell}
          onChange={edit}
          announce={setAnnouncement}
        />
      </section>

      <div className={styles.split}>
        <section className={styles.card} aria-labelledby={`${nameId}-preview`}>
          <h2 id={`${nameId}-preview`} className={styles.heading}>
            {h.preview}
          </h2>
          <Preview
            design={design}
            state={state}
            room={state.rooms.some((r) => r.id === room) ? room : (state.rooms[0]?.id ?? room)}
            size={size}
            onRoom={setRoom}
            onSize={setSize}
            onChanged={reload}
          />
        </section>
        <section className={styles.card} aria-labelledby={`${nameId}-popup`}>
          <h2 id={`${nameId}-popup`} className={styles.heading}>
            {h.popup}
          </h2>
          <PopupEditor design={design} state={state} editable={editable} onChange={edit} />
        </section>
      </div>

      <section className={styles.card} aria-labelledby={`${nameId}-assign`}>
        <h2 id={`${nameId}-assign`} className={styles.heading}>
          {h.assignments}
        </h2>
        <Assignments state={state} onChanged={reload} />
      </section>

      {deleting ? (
        <Dialog title={h.delete} onClose={() => setDeleting(false)}>
          <p>{h.deleteConfirm(design.name)}</p>
          <div className={styles.actions}>
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
  );
}
