/**
 * The HUD editor's preview (R3.9): the design on a table of the room and
 * size picked - made-up players and numbers, the user's dragged panels of
 * that room and size - painted from the HUD renderer's own scene
 * (`hud_preview`: `rail_hud::scene::compose` under the room's permit), so
 * the room's rules cut it down exactly as at a real table. Under it: the
 * room's dragged panels (R3.6's reset) and its preferred-seat answer.
 */
import { useEffect, useState } from "react";

import { useLocale, useT } from "../../i18n";
import { errorText, inApp, ipc, type HudDesign, type HudEditorState, type HudPreview, type PreviewItem } from "../../lib/ipc";
import { problemText, statLabel } from "./problems";
import styles from "./HudEditor.module.css";

const SIZES = [2, 3, 4, 5, 6, 7, 8, 9, 10];
/** How long edits pause before the preview is drawn again. */
const PREVIEW_DEBOUNCE_MS = 150;

const rgba = ([r, g, b, a]: [number, number, number, number]) => `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;

export function Preview({
  design,
  state,
  room,
  size,
  onRoom,
  onSize,
  onChanged,
}: {
  design: HudDesign;
  state: HudEditorState;
  room: string;
  size: number;
  onRoom: (room: string) => void;
  onSize: (size: number) => void;
  /** The store changed (a reset, the preferred seat): read the state again. */
  onChanged: () => void;
}) {
  const t = useT();
  const h = t.hudEditor;
  const locale = useLocale();
  const [preview, setPreview] = useState<HudPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const label = statLabel(state.stats, locale);
  const roomName = state.rooms.find((r) => r.id === room)?.name ?? room;
  const dragged = state.positions.find((p) => p.site === room && p.size === size)?.panels ?? 0;
  const preferred = state.roomSettings.find((s) => s.site === room)?.preferredSeat ?? null;

  useEffect(() => {
    if (!inApp) return;
    let live = true;
    const timer = window.setTimeout(() => {
      ipc
        .hudPreview(design, room, size)
        .then((value) => {
          if (!live) return;
          setPreview(value);
          setError(null);
        })
        .catch((reason: unknown) => {
          if (live) setError(errorText(reason));
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [design, room, size, state]);

  return (
    <div className={styles.preview}>
      <div className={styles.row}>
        <label className={styles.field}>
          <span className={styles.label}>{h.room}</span>
          <select className={styles.input} value={room} onChange={(event) => onRoom(event.target.value)}>
            {state.rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.label}>{h.seats}</span>
          <select className={styles.input} value={size} onChange={(event) => onSize(Number(event.target.value))}>
            {SIZES.map((n) => (
              <option key={n} value={n}>
                {h.seatsN(n)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className={styles.hint}>{h.previewHint}</p>
      {error ? <p className={styles.error}>{h.previewFailed(error)}</p> : null}
      {preview ? (
        <svg
          className={styles.table}
          viewBox={`0 0 ${preview.width} ${preview.height}`}
          role="img"
          aria-label={h.previewLabel(roomName, h.seatsN(preview.size))}
        >
          <rect x={0} y={0} width={preview.width} height={preview.height} className={styles.tableBack} />
          <ellipse
            cx={preview.width / 2}
            cy={preview.height * 0.45}
            rx={preview.width * 0.42}
            ry={preview.height * 0.33}
            className={styles.felt}
          />
          <rect
            x={preview.board.x}
            y={preview.board.y}
            width={preview.board.w}
            height={preview.board.h}
            rx={6}
            className={styles.board}
          />
          {preview.plates.map((plate, slot) => (
            <rect
              key={slot}
              x={plate.x}
              y={plate.y}
              width={plate.w}
              height={plate.h}
              rx={8}
              className={slot === preview.heroSlot ? `${styles.plate} ${styles.plateHero}` : styles.plate}
            />
          ))}
          {preview.panels.map((panel) => {
            const plate = preview.plates[panel.slot];
            return plate ? (
              <text
                key={panel.slot}
                x={plate.x + plate.w / 2}
                y={plate.y + plate.h / 2}
                className={styles.plateText}
                textAnchor="middle"
                dominantBaseline="central"
              >
                {h.stackBb(panel.stackBb)}
              </text>
            ) : null;
          })}
          {preview.items.map((item, index) => (
            <Painted key={index} item={item} />
          ))}
        </svg>
      ) : null}
      {preview ? (
        <section className={styles.roomProblems} aria-live="polite">
          {preview.problems.length === 0 ? (
            <p className={styles.ok}>{h.roomOk(roomName)}</p>
          ) : (
            <>
              <p className={preview.problems.every((p) => p.code === "labels") ? styles.note : styles.refused}>
                {preview.problems.every((p) => p.code === "labels") ? h.roomNotes(roomName) : h.roomRefused(roomName)}
              </p>
              <ul className={styles.problemList}>
                {preview.problems.map((problem, index) => (
                  <li key={index}>{problemText(problem, h.problems, label)}</li>
                ))}
              </ul>
            </>
          )}
        </section>
      ) : null}
      <div className={styles.row}>
        {dragged > 0 ? <p className={styles.hint}>{h.dragged(dragged)}</p> : null}
        <button
          type="button"
          className="btn btn--sm"
          disabled={dragged === 0}
          onClick={() => {
            ipc
              .hudResetSeatPositions(room, size)
              .then((gone) => {
                setNotice(h.resetDone(gone));
                onChanged();
              })
              .catch((reason: unknown) => setNotice(errorText(reason)));
          }}
        >
          {h.resetDragged}
        </button>
      </div>
      <label className={styles.field}>
        <span className={styles.label}>{h.preferredSeat}</span>
        <select
          className={styles.input}
          value={preferred === null ? "auto" : preferred ? "yes" : "no"}
          onChange={(event) => {
            const value = event.target.value === "auto" ? null : event.target.value === "yes";
            ipc
              .hudSetPreferredSeat(room, value)
              .then(onChanged)
              .catch((reason: unknown) => setNotice(errorText(reason)));
          }}
        >
          <option value="auto">{h.preferredSeatAuto}</option>
          <option value="yes">{h.preferredSeatYes}</option>
          <option value="no">{h.preferredSeatNo}</option>
        </select>
      </label>
      {notice ? (
        <p className={styles.hint} role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

/** One item of the HUD's scene. */
function Painted({ item }: { item: PreviewItem }) {
  if (item.kind === "fill") {
    return (
      <rect
        x={item.rect.x}
        y={item.rect.y}
        width={item.rect.w}
        height={item.rect.h}
        rx={item.radius}
        style={{ fill: rgba(item.color) }}
      />
    );
  }
  return (
    <text
      x={item.rect.x + item.rect.w / 2}
      y={item.rect.y + item.rect.h / 2}
      textAnchor="middle"
      dominantBaseline="central"
      style={{ fill: rgba(item.color), fontSize: item.px, fontWeight: item.bold ? 700 : 400 }}
    >
      {item.text}
    </text>
  );
}
