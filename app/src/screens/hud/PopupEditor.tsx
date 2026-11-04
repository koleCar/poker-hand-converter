/**
 * The HUD editor's popup (R3.9), drawn like the popup a click on a panel
 * opens: its sections in order, each with the user's title (else its
 * group's name) and its statistics. Statistics are dragged between and
 * within sections, or in from the library; "+" in a section finds one by
 * name; a section moves up and down. Rail's own statistics only (the
 * user's are on the panel), never the hero's own or money (the popup
 * describes an opponent).
 */
import { useEffect, useRef, useState } from "react";

import { useLocale, useT } from "../../i18n";
import type { HudDesign, HudEditorState, HudStat, PopupSection } from "../../lib/ipc";
import { useDrag, useDropZone, type DragItem } from "./drag";
import styles from "./HudEditor.module.css";

const sectionZone = (index: number) => `popup-${index}`;
const NEW_SECTION_ZONE = "popup-new";

export function PopupEditor({
  design,
  state,
  onChange,
  announce,
}: {
  design: HudDesign;
  state: HudEditorState;
  onChange: (next: HudDesign) => void;
  announce: (message: string) => void;
}) {
  const t = useT();
  const h = t.hudEditor;
  const locale = useLocale();
  const offered = state.stats.filter((stat) => !stat.custom && !stat.heroOnly && !stat.money);
  const offeredIds = new Set(offered.map((stat) => stat.id));
  const label = (id: string) => state.stats.find((stat) => stat.id === id)?.label[locale] ?? id;
  const total = design.popup.reduce((sum, section) => sum + section.stats.length, 0);
  const full = total >= state.limits.maxPopupStats;
  const sectionsFull = design.popup.length >= state.limits.maxPopupSections;
  const setSections = (popup: PopupSection[]) => onChange({ ...design, popup });
  const titleOf = (section: PopupSection) =>
    section.title ?? (section.group ? t.reports.stats.groups[section.group] : h.sectionTitleDefault);

  /** Put `id` into section `to` at `at`, taking it out of where it was dragged from. */
  const place = (item: DragItem, to: number, at: number) => {
    const popup = design.popup.map((section) => ({ ...section, stats: [...section.stats] }));
    let index = at;
    if (item.kind === "popup") {
      const from = popup[item.section];
      if (!from) return;
      from.stats.splice(item.index, 1);
      if (item.section === to && item.index < at) index -= 1;
    } else if (full) {
      announce(h.popupFull(state.limits.maxPopupStats));
      return;
    }
    const target = popup[to];
    if (!target) return;
    target.stats.splice(Math.max(0, Math.min(index, target.stats.length)), 0, item.id);
    setSections(popup);
    announce(h.announcePopupAdded(label(item.id), titleOf(target)));
  };

  const addSection = (item: DragItem | null) => {
    if (sectionsFull) return;
    const popup = design.popup.map((section) => ({ ...section, stats: [...section.stats] }));
    if (item?.kind === "popup") popup[item.section]?.stats.splice(item.index, 1);
    popup.push({ stats: item ? [item.id] : [] });
    setSections(popup);
  };

  useDropZone(
    NEW_SECTION_ZONE,
    (item) => !sectionsFull && item.kind !== "cell" && offeredIds.has(item.id) && (item.kind === "popup" || !full),
    (item) => addSection(item),
  );

  return (
    <div className={styles.popupEditor}>
      <p className={styles.hint}>{h.popupHint}</p>
      <div className={styles.popupFrame}>
        <div className={styles.popupHead}>
          <span className={styles.popupPlayer}>{h.popupPlayer}</span>
          <span className={styles.popupHands}>{h.popupHands}</span>
        </div>
        {design.popup.length === 0 ? <p className={styles.popupEmpty}>{h.popupEmpty}</p> : null}
        {design.popup.map((section, index) => (
          <Section
            key={index}
            index={index}
            section={section}
            count={design.popup.length}
            title={titleOf(section)}
            offered={offered}
            offeredIds={offeredIds}
            full={full}
            label={label}
            onPlace={(item, at) => place(item, index, at)}
            onChange={(next) => setSections(design.popup.map((s, i) => (i === index ? next : s)))}
            onMove={(to) => {
              const popup = [...design.popup];
              const [moved] = popup.splice(index, 1);
              popup.splice(to, 0, moved);
              setSections(popup);
            }}
            onRemove={() => setSections(design.popup.filter((_, i) => i !== index))}
          />
        ))}
        <NewSection disabled={sectionsFull} onClick={() => addSection(null)} />
      </div>
      <p className={styles.hint}>
        {h.popupShipped} {h.popupCount(total, state.limits.maxPopupStats)}
      </p>
    </div>
  );
}

function NewSection({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  const h = useT().hudEditor;
  const { spot, dragging } = useDrag();
  const over = dragging !== null && spot?.zone === NEW_SECTION_ZONE;
  return (
    <button
      type="button"
      data-zone={NEW_SECTION_ZONE}
      className={over ? `${styles.newSection} ${styles.newSectionOver}` : styles.newSection}
      disabled={disabled}
      onClick={onClick}
    >
      + {dragging ? h.addSectionDrop : h.addSection}
    </button>
  );
}

function Section({
  index,
  section,
  count,
  title,
  offered,
  offeredIds,
  full,
  label,
  onPlace,
  onChange,
  onMove,
  onRemove,
}: {
  index: number;
  section: PopupSection;
  count: number;
  title: string;
  offered: readonly HudStat[];
  offeredIds: ReadonlySet<string>;
  full: boolean;
  label: (id: string) => string;
  onPlace: (item: DragItem, at: number) => void;
  onChange: (next: PopupSection) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const h = t.hudEditor;
  const zone = sectionZone(index);
  const { spot, dragging, begin } = useDrag();
  const groupName = section.group ? t.reports.stats.groups[section.group] : h.sectionTitleDefault;

  useDropZone(
    zone,
    (item) => {
      if (item.kind === "cell" || !offeredIds.has(item.id)) return false;
      if (item.kind === "popup") return item.section === index || !section.stats.includes(item.id);
      return !full && !section.stats.includes(item.id);
    },
    (item, at) => onPlace(item, at.index),
  );

  const marker = spot?.zone === zone ? spot.index : null;

  return (
    <section
      className={dragging && marker !== null ? `${styles.popupSection} ${styles.popupSectionOver}` : styles.popupSection}
      data-zone={zone}
      data-end={section.stats.length}
      aria-label={title}
    >
      <div className={styles.popupSectionHead}>
        <input
          className={styles.titleInput}
          value={section.title ?? ""}
          placeholder={groupName}
          aria-label={`${h.section(index + 1)}: ${h.sectionTitle}`}
          maxLength={40}
          onChange={(event) => onChange({ ...section, title: event.target.value === "" ? undefined : event.target.value })}
        />
        <div className={styles.iconRow}>
          <button
            type="button"
            className={styles.iconButton}
            disabled={index === 0}
            aria-label={h.sectionUp(index + 1)}
            title={h.sectionUp(index + 1)}
            onClick={() => onMove(index - 1)}
          >
            ↑
          </button>
          <button
            type="button"
            className={styles.iconButton}
            disabled={index >= count - 1}
            aria-label={h.sectionDown(index + 1)}
            title={h.sectionDown(index + 1)}
            onClick={() => onMove(index + 1)}
          >
            ↓
          </button>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={h.removeSection(index + 1)}
            title={h.removeSection(index + 1)}
            onClick={onRemove}
          >
            ×
          </button>
        </div>
      </div>
      <ul className={styles.popupStats}>
        {section.stats.map((id, i) => (
          <li
            key={id}
            data-slot={i}
            className={[
              styles.popupStat,
              marker === i ? styles.markBefore : "",
              marker === section.stats.length && i === section.stats.length - 1 ? styles.markAfter : "",
              dragging?.kind === "popup" && dragging.section === index && dragging.index === i ? styles.cellDragged : "",
            ].join(" ")}
          >
            <span
              className={styles.popupStatLabel}
              onPointerDown={(event) => begin(event, { kind: "popup", id, label: label(id), section: index, index: i })}
            >
              {label(id)}
            </span>
            <button
              type="button"
              className={styles.popupStatRemove}
              aria-label={h.removeFromSection(label(id))}
              title={h.removeFromSection(label(id))}
              onClick={() => onChange({ ...section, stats: section.stats.filter((s) => s !== id) })}
            >
              ×
            </button>
          </li>
        ))}
        <li>
          <StatPicker
            title={title}
            disabled={full}
            options={offered.filter((stat) => !section.stats.includes(stat.id))}
            onPick={(id) => onChange({ ...section, stats: [...section.stats, id] })}
          />
        </li>
      </ul>
    </section>
  );
}

/** "+": a small search over the statistics a section may still take. */
function StatPicker({
  title,
  disabled,
  options,
  onPick,
}: {
  title: string;
  disabled: boolean;
  options: readonly HudStat[];
  onPick: (id: string) => void;
}) {
  const h = useT().hudEditor;
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [open]);

  const needle = query.trim().toLowerCase();
  const found = options.filter(
    (stat) =>
      needle === "" ||
      stat.label[locale].toLowerCase().includes(needle) ||
      stat.name[locale].toLowerCase().includes(needle),
  );
  const pick = (id: string) => {
    onPick(id);
    setQuery("");
    setOpen(false);
  };

  return (
    <div className={styles.picker} ref={box}>
      <button
        type="button"
        className={styles.pickerButton}
        disabled={disabled}
        aria-expanded={open}
        aria-label={h.addToSectionNamed(title)}
        title={h.addToSectionNamed(title)}
        onClick={() => setOpen((v) => !v)}
      >
        + {h.addToSection}
      </button>
      {open ? (
        <div className={styles.pickerPop}>
          <input
            autoFocus
            type="search"
            className={styles.search}
            value={query}
            placeholder={h.paletteSearch}
            aria-label={h.paletteSearch}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setOpen(false);
              if (event.key === "Enter" && found[0]) {
                event.preventDefault();
                pick(found[0].id);
              }
            }}
          />
          <ul className={styles.pickerList}>
            {found.slice(0, 40).map((stat) => (
              <li key={stat.id}>
                <button type="button" className={styles.pickerOption} onClick={() => pick(stat.id)}>
                  <span className={styles.statChipLabel}>{stat.label[locale]}</span>
                  <span className={styles.statChipName}>{stat.name[locale]}</span>
                </button>
              </li>
            ))}
            {found.length === 0 ? <li className={styles.hint}>{h.noMatch}</li> : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
