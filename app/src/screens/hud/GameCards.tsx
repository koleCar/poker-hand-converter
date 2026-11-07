/**
 * At the tables, on top (R3.9): which design each table gets, as three
 * cards - Cash, Tournaments, Spins -, each with its design's panel drawn
 * small, the design, and the rules that send some of its tables elsewhere
 * (formerly the editor's "Tables", `Assignments.tsx`).
 *
 * Nothing has to be set up: every table gets its game's design - the
 * game's preset until the user picks another for it (an assignment for
 * every room and every size, `*`). Rules then take a room, a table size
 * or a game to another design; the HUD's own resolution picks the most
 * specific (room, then game, then size - `Assignments::resolve`). A room
 * that would refuse a design says why, and the choice is not kept. The
 * decisions are the Rust side's (`hud_assign`); this only asks.
 */
import { useState, type ReactNode } from "react";

import { useLocale, useT } from "../../i18n";
import {
  errorText,
  ipc,
  type DesignProblem,
  type GameFormat,
  type HudAssignment,
  type HudDesign,
  type HudEditorState,
} from "../../lib/ipc";
import { panelRows } from "./panelRows";
import { PopoverButton } from "./popovers";
import { problemText, statLabel } from "./problems";
import styles from "./HudStatusPanel.module.css";

const FORMATS: readonly GameFormat[] = ["cash", "mtt", "spin"];
const SIZES = [2, 3, 4, 5, 6, 7, 8, 9, 10];
const ANY = "*";

/** The per-game default: every room, every size, one game. */
const isGameDefault = (a: HudAssignment) => a.site === ANY && a.size === null && a.format !== null;

type Where = { site: string; size: number | null; format: GameFormat | null };
type Refusal = { refused: Record<string, DesignProblem[]> | null; error: string | null };
/** Where the question was asked: the card's design, or its rules' popover. */
type Asked = { format: GameFormat; from: "card" | "rules" };

export function GameCards({ state, onChanged }: { state: HudEditorState; onChanged: () => void }) {
  const t = useT();
  const h = t.hudEditor;
  const s = t.hudStatus;
  const locale = useLocale();
  const label = statLabel(state.stats, locale);
  /** The last answer that refused, and on which card it was asked. */
  const [answer, setAnswer] = useState<(Refusal & Asked) | null>(null);

  const roomName = (id: string) => (id === ANY ? h.allRooms : (state.rooms.find((room) => room.id === id)?.name ?? id));
  const designName = (id: string) =>
    state.presets.find((p) => p.id === id)?.name[locale] ?? state.designs.find((d) => d.id === id)?.design.name ?? id;
  const designOf = (id: string): HudDesign | null =>
    state.presets.find((p) => p.id === id)?.design ?? state.designs.find((d) => d.id === id)?.design ?? null;

  /** Ask the Rust side; `then` runs once it took the choice. */
  const choose = (asked: Asked, where: Where, layout: string | null, then?: () => void) => {
    setAnswer(null);
    ipc
      .hudAssign(where.site, where.size, where.format, layout)
      .then((result) => {
        if (result.ok) {
          then?.();
          onChanged();
        } else {
          setAnswer({ ...asked, refused: result.refused, error: null });
        }
      })
      .catch((reason: unknown) => setAnswer({ ...asked, refused: null, error: errorText(reason) }));
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

  const refusal = (r: Refusal) => (
    <div aria-live="polite">
      {r.refused
        ? Object.entries(r.refused).map(([room, list]) => (
            <div key={room} className={styles.refusedBox}>
              <p>{h.assignRefused(roomName(room))}</p>
              <ul className={styles.problemList}>
                {list.map((problem, index) => (
                  <li key={index}>{problemText(problem, h.problems, label)}</li>
                ))}
              </ul>
            </div>
          ))
        : null}
      {r.error ? <p className={styles.error}>{r.error}</p> : null}
    </div>
  );

  return (
    <div className={styles.games}>
      {FORMATS.map((format) => {
        const chosen = state.assignments.find((a) => isGameDefault(a) && a.format === format);
        const preset = state.defaults[format];
        const layout = chosen?.layout ?? preset;
        const design = designOf(layout);
        const rules = state.assignments.filter((a) => !isGameDefault(a) && (a.format === format || a.format === null));
        const id = `hud-game-${format}`;
        return (
          <section key={format} className={styles.game} aria-labelledby={id}>
            <h2 id={id} className={styles.gameName}>
              {s.games[format]}
            </h2>
            <div className={styles.felt}>
              {design ? <MiniPanel design={design} name={designName(layout)} label={label} /> : null}
            </div>
            <select
              className={styles.control}
              value={layout}
              aria-label={h.assignTo(h.allRooms, h.formats[format], h.allSizes)}
              onChange={(event) =>
                choose({ format, from: "card" }, { site: ANY, size: null, format }, event.target.value === preset ? null : event.target.value)
              }
            >
              {designOptions}
            </select>
            {chosen && Object.keys(chosen.refused).length > 0 ? (
              <ProblemsLine assignment={chosen} roomName={roomName} label={label} />
            ) : null}
            <RulesLink
              format={format}
              state={state}
              rules={rules}
              roomName={roomName}
              designOptions={designOptions}
              defaultLayout={layout}
              choose={(where, value, then) => choose({ format, from: "rules" }, where, value, then)}
              refusal={answer?.format === format && answer.from === "rules" ? refusal(answer) : null}
              label={label}
            />
            {answer?.format === format && answer.from === "card" ? refusal(answer) : null}
          </section>
        );
      })}
    </div>
  );
}

/** "At Winamax the HUD leaves out: …", under a design some room takes only in part. */
function ProblemsLine({
  assignment,
  roomName,
  label,
}: {
  assignment: HudAssignment;
  roomName: (id: string) => string;
  label: (id: string) => string;
}) {
  const h = useT().hudEditor;
  return (
    <>
      {Object.entries(assignment.refused).map(([room, list]) => (
        <p key={room} className={styles.note}>
          {h.assignedProblems(roomName(room))} {list.map((p) => problemText(p, h.problems, label)).join("; ")}
        </p>
      ))}
    </>
  );
}

/** The design's panel, drawn small: its statistics in the HUD's rows and columns. */
function MiniPanel({ design, name, label }: { design: HudDesign; name: string; label: (id: string) => string }) {
  const s = useT().hudStatus;
  const rows = panelRows(design);
  return (
    <div
      className={styles.mini}
      role="img"
      aria-label={s.panelOf(name)}
      style={{ gridTemplateColumns: `repeat(${Math.max(1, design.columns)}, auto)` }}
    >
      {rows.flatMap((row, r) =>
        row.map((cell, c) => (
          <span key={`${r}:${c}`} className={styles.miniCell}>
            {cell ? label(cell.stat) : null}
          </span>
        )),
      )}
    </div>
  );
}

/**
 * "1 rule: Winamax heads-up ›" (or a dim "+ Rule"), and the rules as
 * sentences in a popover: `At [room] [game] [size] use [design] ×`.
 */
function RulesLink({
  format,
  state,
  rules,
  roomName,
  designOptions,
  defaultLayout,
  choose,
  refusal,
  label,
}: {
  format: GameFormat;
  state: HudEditorState;
  rules: HudAssignment[];
  roomName: (id: string) => string;
  designOptions: ReactNode;
  defaultLayout: string;
  choose: (where: Where, layout: string | null, then?: () => void) => void;
  refusal: ReactNode;
  label: (id: string) => string;
}) {
  const t = useT();
  const h = t.hudEditor;
  const s = t.hudStatus;
  const [draft, setDraft] = useState<(Where & { layout: string }) | null>(null);

  const sizeName = (size: number | null) => (size === null ? h.allSizes : h.seatsN(size));
  const formatName = (f: GameFormat | null) => (f === null ? h.allFormats : h.formats[f]);
  const describe = (rule: HudAssignment) => {
    const parts = [rule.site === ANY ? null : roomName(rule.site), rule.size === null ? null : sizeName(rule.size)].filter(
      (part): part is string => part !== null,
    );
    return parts.length > 0 ? parts.join(" ") : formatName(rule.format);
  };
  const first = rules[0];
  const text = first ? s.rules.summary(rules.length, describe(first)) : s.rules.add;

  return (
    <PopoverButton
      label={s.rules.label(s.games[format])}
      content={text}
      className={first ? styles.rulesLink : `${styles.rulesLink} ${styles.dim}`}
      align="start"
      popoverClassName={styles.rules}
    >
      {() => (
        <>
          {rules.map((rule) => {
            const where = [roomName(rule.site), formatName(rule.format), sizeName(rule.size)];
            /** Moving a rule: the new one first; the old one goes only once the new one is taken. */
            const move = (next: Where) =>
              choose(next, rule.layout, () => choose({ site: rule.site, size: rule.size, format: rule.format }, null));
            return (
              <RuleSentence
                key={`${rule.site}|${rule.size}|${rule.format}`}
                state={state}
                where={{ site: rule.site, size: rule.size, format: rule.format }}
                layout={rule.layout}
                designOptions={designOptions}
                onWhere={move}
                onLayout={(layout) => choose({ site: rule.site, size: rule.size, format: rule.format }, layout)}
                end={
                  <button
                    type="button"
                    className={styles.iconButton}
                    aria-label={h.removeRule(where.join(", "))}
                    title={h.removeRule(where.join(", "))}
                    onClick={() => choose({ site: rule.site, size: rule.size, format: rule.format }, null)}
                  >
                    ×
                  </button>
                }
                problems={
                  Object.keys(rule.refused).length > 0 ? (
                    <ProblemsLine assignment={rule} roomName={roomName} label={label} />
                  ) : null
                }
              />
            );
          })}
          {draft ? (
            <RuleSentence
              state={state}
              where={draft}
              layout={draft.layout}
              designOptions={designOptions}
              onWhere={(where) => setDraft({ ...draft, ...where })}
              onLayout={(layout) => setDraft({ ...draft, layout })}
              end={
                <>
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    onClick={() => choose(draft, draft.layout, () => setDraft(null))}
                  >
                    {s.rules.add1}
                  </button>
                  <button
                    type="button"
                    className={styles.iconButton}
                    aria-label={h.cancel}
                    title={h.cancel}
                    onClick={() => setDraft(null)}
                  >
                    ×
                  </button>
                </>
              }
              problems={null}
            />
          ) : (
            <button
              type="button"
              className={styles.textButton}
              onClick={() => setDraft({ site: state.rooms[0]?.id ?? ANY, size: null, format, layout: defaultLayout })}
            >
              {s.rules.addRule}
            </button>
          )}
          {refusal}
        </>
      )}
    </PopoverButton>
  );
}

/** One rule as a sentence: `At [room] [game] [size] use [design]`, then its buttons. */
function RuleSentence({
  state,
  where,
  layout,
  designOptions,
  onWhere,
  onLayout,
  end,
  problems,
}: {
  state: HudEditorState;
  where: Where;
  layout: string;
  designOptions: ReactNode;
  onWhere: (where: Where) => void;
  onLayout: (layout: string) => void;
  end: ReactNode;
  problems: ReactNode;
}) {
  const t = useT();
  const h = t.hudEditor;
  const s = t.hudStatus;
  return (
    <div className={styles.ruleRow}>
      <div className={styles.sentence}>
        <span className={styles.word}>{s.rules.at}</span>
        <select
          className={styles.control}
          aria-label={h.room}
          value={where.site}
          onChange={(event) => onWhere({ ...where, site: event.target.value })}
        >
          <option value={ANY}>{h.allRooms}</option>
          {state.rooms.map((room) => (
            <option key={room.id} value={room.id}>
              {room.name}
            </option>
          ))}
        </select>
        <select
          className={styles.control}
          aria-label={h.game}
          value={where.format ?? "all"}
          onChange={(event) =>
            onWhere({ ...where, format: event.target.value === "all" ? null : (event.target.value as GameFormat) })
          }
        >
          <option value="all">{h.allFormats}</option>
          {FORMATS.map((f) => (
            <option key={f} value={f}>
              {h.formats[f]}
            </option>
          ))}
        </select>
        <select
          className={styles.control}
          aria-label={h.sizeFilter}
          value={where.size === null ? "all" : String(where.size)}
          onChange={(event) => onWhere({ ...where, size: event.target.value === "all" ? null : Number(event.target.value) })}
        >
          <option value="all">{h.allSizes}</option>
          {SIZES.map((n) => (
            <option key={n} value={n}>
              {h.seatsN(n)}
            </option>
          ))}
        </select>
        <span className={styles.word}>{s.rules.use}</span>
        <select
          className={styles.control}
          aria-label={h.design}
          value={layout}
          onChange={(event) => onLayout(event.target.value)}
        >
          {designOptions}
        </select>
        {end}
      </div>
      {problems}
    </div>
  );
}
