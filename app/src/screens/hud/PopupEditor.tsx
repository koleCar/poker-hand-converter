/**
 * The HUD editor's popup (R3.9): the sections a click on a panel shows, in
 * order - each with the user's title (else its group's name) and its
 * statistics. Rail's own statistics only (a user's are on the panel), never
 * the hero's own or money (the popup describes an opponent).
 */
import { useLocale, useT } from "../../i18n";
import type { HudDesign, HudEditorState, PopupSection } from "../../lib/ipc";
import styles from "./HudEditor.module.css";

export function PopupEditor({
  design,
  state,
  editable,
  onChange,
}: {
  design: HudDesign;
  state: HudEditorState;
  editable: boolean;
  onChange: (next: HudDesign) => void;
}) {
  const t = useT();
  const h = t.hudEditor;
  const locale = useLocale();
  const offered = state.stats.filter((stat) => !stat.custom && !stat.heroOnly && !stat.money);
  const label = (id: string) => state.stats.find((stat) => stat.id === id)?.label[locale] ?? id;
  const total = design.popup.reduce((sum, section) => sum + section.stats.length, 0);
  const setSections = (popup: PopupSection[]) => onChange({ ...design, popup });
  const setSection = (index: number, next: PopupSection) =>
    setSections(design.popup.map((section, i) => (i === index ? next : section)));

  return (
    <div className={styles.popupEditor}>
      <p className={styles.hint}>{h.popupHint}</p>
      <p className={styles.hint}>{h.popupShipped}</p>
      <ol className={styles.sections}>
        {design.popup.map((section, index) => {
          const groupName = section.group ? t.reports.stats.groups[section.group] : h.sectionTitleDefault;
          return (
            <li key={index} className={styles.section}>
              <div className={styles.row}>
                <label className={styles.field}>
                  <span className={styles.label}>
                    {h.section(index + 1)} · {h.sectionTitle}
                  </span>
                  <input
                    className={styles.input}
                    value={section.title ?? ""}
                    placeholder={groupName}
                    disabled={!editable}
                    maxLength={40}
                    onChange={(event) =>
                      setSection(index, {
                        ...section,
                        title: event.target.value === "" ? undefined : event.target.value,
                      })
                    }
                  />
                </label>
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={!editable}
                  onClick={() => setSections(design.popup.filter((_, i) => i !== index))}
                >
                  {h.removeSection(index + 1)}
                </button>
              </div>
              <ul className={styles.sectionStats}>
                {section.stats.map((id, i) => (
                  <li key={id} className={styles.sectionStat}>
                    <span className={styles.chip}>{label(id)}</span>
                    <button
                      type="button"
                      className="btn btn--sm btn--icon"
                      disabled={!editable || i === 0}
                      aria-label={h.moveUp(label(id))}
                      title={h.moveUp(label(id))}
                      onClick={() => {
                        const stats = [...section.stats];
                        [stats[i - 1], stats[i]] = [stats[i], stats[i - 1]];
                        setSection(index, { ...section, stats });
                      }}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="btn btn--sm btn--icon"
                      disabled={!editable}
                      aria-label={h.removeFromSection(label(id))}
                      title={h.removeFromSection(label(id))}
                      onClick={() => setSection(index, { ...section, stats: section.stats.filter((s) => s !== id) })}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
              <label className={styles.field}>
                <span className={styles.label}>{h.addToSection}</span>
                <select
                  className={styles.input}
                  value=""
                  disabled={!editable || total >= state.limits.maxPopupStats}
                  onChange={(event) => {
                    if (event.target.value !== "") {
                      setSection(index, { ...section, stats: [...section.stats, event.target.value] });
                    }
                  }}
                >
                  <option value="">{h.addToSection}</option>
                  {offered
                    .filter((stat) => !section.stats.includes(stat.id))
                    .map((stat) => (
                      <option key={stat.id} value={stat.id}>
                        {`${stat.label[locale]} · ${stat.name[locale]}`}
                      </option>
                    ))}
                </select>
              </label>
            </li>
          );
        })}
      </ol>
      <button
        type="button"
        className="btn btn--sm"
        disabled={!editable || design.popup.length >= state.limits.maxPopupSections}
        onClick={() => setSections([...design.popup, { stats: [] }])}
      >
        {h.addSection}
      </button>
    </div>
  );
}
