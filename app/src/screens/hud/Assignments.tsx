/**
 * The HUD editor's assignment matrix (R3.9): room (and "every room") by
 * game format, at every table size or one. A cell's select chooses the
 * design for exactly that (room, size, format); "as it falls through"
 * names what the HUD resolves there today (`resolved`, the HUD's own
 * resolution: room, then format, then size, then the format's preset). A
 * room that would refuse a design says why, and the choice is not kept.
 */
import { useState } from "react";

import { useLocale, useT } from "../../i18n";
import { errorText, ipc, type DesignProblem, type GameFormat, type HudEditorState } from "../../lib/ipc";
import { problemText, statLabel } from "./problems";
import styles from "./HudEditor.module.css";

/** `null`: every game. */
const FORMATS: readonly (GameFormat | null)[] = [null, "cash", "mtt", "spin"];
const SIZES = [2, 3, 4, 5, 6, 7, 8, 9, 10];
const ANY = "*";

export function Assignments({ state, onChanged }: { state: HudEditorState; onChanged: () => void }) {
  const t = useT();
  const h = t.hudEditor;
  const locale = useLocale();
  const [size, setSize] = useState<number | null>(null);
  const [refused, setRefused] = useState<Record<string, DesignProblem[]> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const label = statLabel(state.stats, locale);

  const nameOf = (id: string) => {
    const preset = state.presets.find((p) => p.id === id);
    if (preset) return preset.name[locale];
    return state.designs.find((d) => d.id === id)?.design.name ?? id;
  };
  const explicit = (site: string, format: GameFormat | null) =>
    state.assignments.find((a) => a.site === site && a.size === size && a.format === format);
  const resolved = (site: string, format: GameFormat) =>
    state.resolved.find((r) => r.site === site && r.size === size && r.format === format);
  const formatName = (format: GameFormat | null) => (format === null ? h.allFormats : h.formats[format]);
  const sizeName = size === null ? h.allSizes : h.seatsN(size);
  const rows: { id: string; name: string }[] = [
    { id: ANY, name: h.allRooms },
    ...state.rooms.map((room) => ({ id: room.id, name: room.name })),
  ];
  const roomName = (id: string) => state.rooms.find((room) => room.id === id)?.name ?? id;

  const choose = (site: string, format: GameFormat | null, layout: string | null) => {
    setRefused(null);
    setError(null);
    ipc
      .hudAssign(site, size, format, layout)
      .then((answer) => {
        if (answer.ok) {
          onChanged();
        } else {
          setRefused(answer.refused);
        }
      })
      .catch((reason: unknown) => setError(errorText(reason)));
  };

  return (
    <div className={styles.assignments}>
      <p className={styles.hint}>{h.assignmentsHint}</p>
      <label className={styles.field}>
        <span className={styles.label}>{h.sizeFilter}</span>
        <select
          className={styles.input}
          value={size === null ? "all" : String(size)}
          onChange={(event) => setSize(event.target.value === "all" ? null : Number(event.target.value))}
        >
          <option value="all">{h.allSizes}</option>
          {SIZES.map((n) => (
            <option key={n} value={n}>
              {h.seatsN(n)}
            </option>
          ))}
        </select>
      </label>
      <table className={styles.matrix}>
        <thead>
          <tr>
            <th scope="col">{h.room}</th>
            {FORMATS.map((format) => (
              <th key={format ?? ANY} scope="col">
                {formatName(format)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <th scope="row">{row.name}</th>
              {FORMATS.map((format) => {
                const chosen = explicit(row.id, format);
                const falls = row.id === ANY || format === null ? undefined : resolved(row.id, format);
                const inherited =
                  format === null
                    ? null
                    : falls
                      ? nameOf(falls.layout)
                      : nameOf(state.defaults[format]);
                const problems = chosen ? Object.entries(chosen.refused) : [];
                return (
                  <td key={format ?? ANY}>
                    <select
                      className={chosen ? `${styles.input} ${styles.assigned}` : styles.input}
                      value={chosen?.layout ?? ""}
                      aria-label={h.assignTo(row.name, formatName(format), sizeName)}
                      onChange={(event) => choose(row.id, format, event.target.value === "" ? null : event.target.value)}
                    >
                      <option value="">{inherited === null ? h.notSet : h.inherit(inherited)}</option>
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
                    </select>
                    {chosen ? <span className={styles.assignedTag}>{h.assignedHere}</span> : null}
                    {problems.map(([room, list]) => (
                      <p key={room} className={styles.refused}>
                        {h.assignedProblems(roomName(room))} {list.map((p) => problemText(p, h.problems, label)).join("; ")}
                      </p>
                    ))}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
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
