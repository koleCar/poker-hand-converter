/**
 * The HUD editor's "Tables" (R3.9): which design each table gets.
 *
 * Nothing has to be set up: every table gets its game's design - the
 * game's preset until the user picks another for it (an assignment for
 * every room and every size, `*`). Rules then take a room, a table size
 * or a game to another design; the HUD's own resolution picks the most
 * specific (room, then game, then size - `Assignments::resolve`). A room
 * that would refuse a design says why, and the choice is not kept.
 */
import { useState } from "react";

import { useLocale, useT } from "../../i18n";
import {
  errorText,
  ipc,
  type DesignProblem,
  type GameFormat,
  type HudAssignment,
  type HudEditorState,
} from "../../lib/ipc";
import { problemText, statLabel } from "./problems";
import styles from "./HudEditor.module.css";

const FORMATS: readonly GameFormat[] = ["cash", "mtt", "spin"];
const SIZES = [2, 3, 4, 5, 6, 7, 8, 9, 10];
const ANY = "*";

/** The per-game default: every room, every size, one game. */
const isGameDefault = (a: HudAssignment) => a.site === ANY && a.size === null && a.format !== null;

export function Assignments({ state, onChanged }: { state: HudEditorState; onChanged: () => void }) {
  const t = useT();
  const h = t.hudEditor;
  const locale = useLocale();
  const [refused, setRefused] = useState<Record<string, DesignProblem[]> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ site: string; size: number | null; format: GameFormat | null; layout: string }>(
    () => ({ site: state.rooms[0]?.id ?? ANY, size: null, format: "cash", layout: state.defaults.cash }),
  );
  const [adding, setAdding] = useState(false);
  const label = statLabel(state.stats, locale);

  const roomName = (id: string) => (id === ANY ? h.allRooms : (state.rooms.find((room) => room.id === id)?.name ?? id));
  const formatName = (format: GameFormat | null) => (format === null ? h.allFormats : h.formats[format]);
  const sizeName = (size: number | null) => (size === null ? h.allSizes : h.seatsN(size));
  const gameDefault = (format: GameFormat) =>
    state.assignments.find((a) => isGameDefault(a) && a.format === format);
  const rules = state.assignments.filter((a) => !isGameDefault(a));

  const choose = (site: string, size: number | null, format: GameFormat | null, layout: string | null, done?: () => void) => {
    setRefused(null);
    setError(null);
    ipc
      .hudAssign(site, size, format, layout)
      .then((answer) => {
        if (answer.ok) {
          done?.();
          onChanged();
        } else {
          setRefused(answer.refused);
        }
      })
      .catch((reason: unknown) => setError(errorText(reason)));
  };

  const designOptions = (
    <>
      <optgroup label={h.presetsGroup}>
        {state.presets.map((preset) => (
          <option key={preset.id} value={preset.id}>
            {preset.name[locale]}
          </option>
        ))}
      </optgroup>
      {state.designs.length > 0 ? (
        <optgroup label={h.yoursGroup}>
          {state.designs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.design.name}
            </option>
          ))}
        </optgroup>
      ) : null}
    </>
  );

  const problemsOf = (a: HudAssignment | undefined) =>
    a
      ? Object.entries(a.refused).map(([room, list]) => (
          <p key={room} className={styles.noteText}>
            {h.assignedProblems(roomName(room))} {list.map((p) => problemText(p, h.problems, label)).join("; ")}
          </p>
        ))
      : null;

  return (
    <div className={styles.assignments}>
      <p className={styles.hint}>{h.assignmentsHint}</p>

      <ul className={styles.gameRows}>
        {FORMATS.map((format) => {
          const chosen = gameDefault(format);
          const preset = state.defaults[format];
          const layout = chosen?.layout ?? preset;
          return (
            <li key={format} className={styles.gameRow}>
              <div className={styles.gameName}>
                <span className={styles.gameTitle}>{h.gameRows[format]}</span>
                <span className={styles.hint}>{chosen ? h.yourChoice : h.byDefault}</span>
              </div>
              <span className={styles.arrow} aria-hidden="true">
                →
              </span>
              <div className={styles.gameChoice}>
                <select
                  className={chosen ? `${styles.input} ${styles.assigned}` : styles.input}
                  value={layout}
                  aria-label={h.assignTo(h.allRooms, h.formats[format], h.allSizes)}
                  onChange={(event) =>
                    choose(ANY, null, format, event.target.value === preset ? null : event.target.value)
                  }
                >
                  {designOptions}
                </select>
                {problemsOf(chosen)}
              </div>
            </li>
          );
        })}
      </ul>

      <div className={styles.rulesHead}>
        <h3 className={styles.subheading}>{h.rulesHeading}</h3>
        {!adding ? (
          <button type="button" className="btn btn--sm" onClick={() => setAdding(true)}>
            + {h.addRule}
          </button>
        ) : null}
      </div>
      {rules.length === 0 && !adding ? <p className={styles.hint}>{h.noRules}</p> : null}
      {rules.length > 0 ? (
        <ul className={styles.ruleList}>
          {rules.map((rule) => {
            const where = [roomName(rule.site), sizeName(rule.size), formatName(rule.format)];
            return (
              <li key={`${rule.site}|${rule.size}|${rule.format}`} className={styles.rule}>
                <div className={styles.ruleWhere}>
                  {where.map((part, i) => (
                    <span key={i} className={styles.rulePart}>
                      {part}
                    </span>
                  ))}
                </div>
                <span className={styles.arrow} aria-hidden="true">
                  →
                </span>
                <div className={styles.gameChoice}>
                  <select
                    className={`${styles.input} ${styles.assigned}`}
                    value={rule.layout}
                    aria-label={h.assignTo(where[0], where[2], where[1])}
                    onChange={(event) => choose(rule.site, rule.size, rule.format, event.target.value)}
                  >
                    {designOptions}
                  </select>
                  {problemsOf(rule)}
                </div>
                <button
                  type="button"
                  className={styles.iconButton}
                  aria-label={h.removeRule(where.join(", "))}
                  title={h.removeRule(where.join(", "))}
                  onClick={() => choose(rule.site, rule.size, rule.format, null)}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

      {adding ? (
        <div className={styles.newRule}>
          <label className={styles.field}>
            <span className={styles.toolLabel}>{h.room}</span>
            <select
              className={styles.input}
              value={draft.site}
              onChange={(event) => setDraft({ ...draft, site: event.target.value })}
            >
              <option value={ANY}>{h.allRooms}</option>
              {state.rooms.map((room) => (
                <option key={room.id} value={room.id}>
                  {room.name}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.toolLabel}>{h.sizeFilter}</span>
            <select
              className={styles.input}
              value={draft.size === null ? "all" : String(draft.size)}
              onChange={(event) => setDraft({ ...draft, size: event.target.value === "all" ? null : Number(event.target.value) })}
            >
              <option value="all">{h.allSizes}</option>
              {SIZES.map((n) => (
                <option key={n} value={n}>
                  {h.seatsN(n)}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.toolLabel}>{h.game}</span>
            <select
              className={styles.input}
              value={draft.format ?? "all"}
              onChange={(event) =>
                setDraft({ ...draft, format: event.target.value === "all" ? null : (event.target.value as GameFormat) })
              }
            >
              <option value="all">{h.allFormats}</option>
              {FORMATS.map((format) => (
                <option key={format} value={format}>
                  {h.formats[format]}
                </option>
              ))}
            </select>
          </label>
          <span className={styles.arrow} aria-hidden="true">
            →
          </span>
          <label className={styles.field}>
            <span className={styles.toolLabel}>{h.design}</span>
            <select
              className={styles.input}
              value={draft.layout}
              onChange={(event) => setDraft({ ...draft, layout: event.target.value })}
            >
              {designOptions}
            </select>
          </label>
          <div className={styles.inline}>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => choose(draft.site, draft.size, draft.format, draft.layout, () => setAdding(false))}
            >
              {h.addRule}
            </button>
            <button type="button" className="btn btn--sm" onClick={() => setAdding(false)}>
              {h.cancel}
            </button>
          </div>
        </div>
      ) : null}

      <div aria-live="polite">
        {refused
          ? Object.entries(refused).map(([room, list]) => (
              <div key={room} className={styles.refusedBox}>
                <p className={styles.refused}>{h.assignRefused(roomName(room))}</p>
                <ul className={styles.problemList}>
                  {list.map((problem, index) => (
                    <li key={index}>{problemText(problem, h.problems, label)}</li>
                  ))}
                </ul>
              </div>
            ))
          : null}
        {error ? <p className={styles.error}>{error}</p> : null}
      </div>
    </div>
  );
}
