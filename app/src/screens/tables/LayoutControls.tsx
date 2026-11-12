/**
 * (T5) The user's layouts, beside the layout picker:
 *
 * - **+ Layout**: a name, then "Save current arrangement" - the HUD
 *   measures where the tiled tables are now (`capture_tiling_layout`, a
 *   slot per place, thousandths of each display's work area) and the layout
 *   is saved and put in force, so nothing moves - or "Draw slots": the slot
 *   editor opens on an empty layout of that name.
 * - **⋯** on the layout in force: edit its slots, duplicate it, rename it,
 *   delete it (the auto grid takes over, and the rules that switched to it
 *   go).
 */
import { useState } from "react";

import { useT } from "../../i18n";
import { errorText, ipc, type TilingLayout, type TilingSettings } from "../../lib/ipc";
import { MoreMenu, PopoverButton } from "../hud/popovers";
import type { EditorTarget } from "./SlotEditor";
import { MAX_LAYOUTS, MAX_NAME, addLayout, cleanName, deleteLayout, newLayoutName, renameLayout } from "./model";
import { blankLayout, duplicateLayout, uniqueName } from "./slots";
import styles from "./Tables.module.css";

export function LayoutAdd({
  settings,
  onSave,
  onEdit,
}: {
  settings: TilingSettings;
  onSave: (next: TilingSettings) => Promise<boolean>;
  onEdit: (target: EditorTarget) => void;
}) {
  const s = useT().tables;
  return (
    <PopoverButton
      label={s.newLayout}
      content={s.addLayout}
      className={`btn btn--sm btn--ghost ${styles.headerButton}`}
      popoverClassName={styles.popover}
    >
      {(close) => <AddForm settings={settings} onSave={onSave} onEdit={onEdit} close={close} />}
    </PopoverButton>
  );
}

function AddForm({
  settings,
  onSave,
  onEdit,
  close,
}: {
  settings: TilingSettings;
  onSave: (next: TilingSettings) => Promise<boolean>;
  onEdit: (target: EditorTarget) => void;
  close: () => void;
}) {
  const s = useT().tables;
  const [name, setName] = useState(() => newLayoutName(settings.layouts, s.defaultName));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const full = settings.layouts.length >= MAX_LAYOUTS;
  const blocked = !settings.enabled ? s.needsTiling : full ? s.tooManyLayouts(MAX_LAYOUTS) : null;
  const save = () => {
    setBusy(true);
    setMessage(null);
    ipc
      .captureTilingLayout()
      .then(async (slots) => {
        const next = addLayout(settings, slots, name);
        if (next === null) {
          setMessage(slots.length === 0 ? s.nothingToSave : s.tooManyLayouts(MAX_LAYOUTS));
          return;
        }
        if (await onSave(next)) close();
      })
      .catch((e: unknown) => setMessage(errorText(e)))
      .finally(() => setBusy(false));
  };
  const draw = () => {
    const clean = cleanName(name);
    if (clean === null || full) return;
    onEdit({ layout: blankLayout(settings, clean), existing: false });
    close();
  };
  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        if (blocked === null && !busy && cleanName(name) !== null) save();
      }}
    >
      <label className={styles.field}>
        <span>{s.layoutName}</span>
        <input className={styles.input} value={name} maxLength={MAX_NAME} onChange={(e) => setName(e.target.value)} />
      </label>
      <p className={styles.hint}>{blocked ?? s.saveHint}</p>
      {message !== null ? <p className={styles.error}>{message}</p> : null}
      <div className={styles.formActions}>
        <button type="submit" className="btn btn--sm btn--primary" disabled={blocked !== null || busy || cleanName(name) === null}>
          {busy ? s.saving : s.saveArrangement}
        </button>
        <button type="button" className="btn btn--sm" disabled={full || cleanName(name) === null} onClick={draw}>
          {s.drawSlots}
        </button>
      </div>
    </form>
  );
}

export function LayoutMenu({
  layout,
  settings,
  onSave,
  onEdit,
}: {
  layout: TilingLayout;
  settings: TilingSettings;
  onSave: (next: TilingSettings) => void;
  onEdit: (target: EditorTarget) => void;
}) {
  const s = useT().tables;
  return (
    <MoreMenu label={s.layoutMenu(layout.name)}>
      {(close) => <LayoutMenuBody layout={layout} settings={settings} onSave={onSave} onEdit={onEdit} close={close} />}
    </MoreMenu>
  );
}

function LayoutMenuBody({
  layout,
  settings,
  onSave,
  onEdit,
  close,
}: {
  layout: TilingLayout;
  settings: TilingSettings;
  onSave: (next: TilingSettings) => void;
  onEdit: (target: EditorTarget) => void;
  close: () => void;
}) {
  const s = useT().tables;
  const [name, setName] = useState(layout.name);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div className={styles.form}>
      <div className={styles.formActions}>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => {
            onEdit({ layout, existing: true });
            close();
          }}
        >
          {s.editSlots}
        </button>
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          disabled={settings.layouts.length >= MAX_LAYOUTS}
          onClick={() => {
            const copy = duplicateLayout(settings, layout.id, uniqueName(settings.layouts, s.copyName(layout.name)));
            if (copy === null) return;
            if (!copy.ok) {
              setProblem(s.editor.problem[copy.problem]);
              return;
            }
            onSave(copy.settings);
            close();
          }}
        >
          {s.duplicate}
        </button>
      </div>
      <form
        className={styles.inline}
        onSubmit={(event) => {
          event.preventDefault();
          if (cleanName(name) === null) return;
          onSave(renameLayout(settings, layout.id, name));
          close();
        }}
      >
        <input className={styles.input} aria-label={s.rename} value={name} maxLength={MAX_NAME} onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="btn btn--sm" disabled={cleanName(name) === null || cleanName(name) === layout.name}>
          {s.save}
        </button>
      </form>
      {problem !== null ? <p className={styles.error}>{problem}</p> : null}
      <button
        type="button"
        className={`btn btn--sm btn--ghost ${styles.danger}`}
        onClick={() => {
          onSave(deleteLayout(settings, layout.id));
          close();
        }}
      >
        {s.deleteLayout}
      </button>
    </div>
  );
}
