/**
 * The user's own preflop charts (R5.3): their chart sets, an editor per set
 * and the comparison with the hands they played. Shared so the desktop app
 * can render it once it has the analysis (R5.4); today the web does, at
 * `/analysis/my-charts`.
 *
 * What is the surface's: the data (`PreflopChartsSource`), where the screen
 * is (`selected`, `view`, `onNavigate` - the web keeps them in the address),
 * how a hand opens (`renderHandLink`, at the decision) and the states' look.
 * Off-table only (A10): `hiddenDuringPlay` renders a notice and reads nothing.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { errorText } from "../hands/model";
import { useUiStrings, type ChartsStrings } from "../i18n";
import { dateFormat } from "../stats/format";
import { ChartCompare, type ChartHandLinkProps } from "./ChartCompare";
import { ChartEditor, strayKeys } from "./ChartEditor";
import { exportRailJsonText, importRailJson, type ImportProblem } from "./exchange";
import { LIMITS, newChartSet, validateChartSet, type ChartProblem, type ChartSet } from "./model";
import type { ChartSummary, ComparePeriod, PreflopChartsSource } from "./source";
import styles from "./Charts.module.css";

export type ChartsView = "edit" | "compare";
/** A new, unsaved set in the address. */
export const NEW_SET = "new";

export interface ChartsScreenProps {
  source: PreflopChartsSource;
  title: string;
  titleTag?: "h1" | "h2";
  /** Under the title: the surface's own navigation. */
  notice?: ReactNode;
  renderState: (kind: "loading" | "empty" | "error", text: string) => ReactNode;
  renderHandLink: (props: ChartHandLinkProps) => ReactNode;
  /** The open set's id, {@link NEW_SET}, or null for the list. */
  selected: string | null;
  view: ChartsView;
  /** The situation the editor opens at (`model.ts`' key). */
  situation?: string | null;
  period?: ComparePeriod;
  onNavigate: (to: { selected: string | null; view: ChartsView; situation?: string | null; period?: ComparePeriod }) => void;
  hiddenDuringPlay?: boolean;
}

/** The open set; `token` names it for the editor across its first save (its id changes, the editor stays). */
type Draft = { id: string | null; set: ChartSet; dirty: boolean; token: number } | null;

let nextToken = 1;

/** A set's problem (`validateChartSet`'s code) in the reader's words. */
export function chartProblemText(t: ChartsStrings, code: string, detail: string): string {
  const w = t.problems;
  switch (code) {
    case "name":
      return w.name;
    case "stack-range":
      return w["stack-range"];
    case "too-many-nodes":
      return w["too-many-nodes"];
    case "node-key":
      return w["node-key"](detail);
    case "action-not-allowed":
      return w["action-not-allowed"](detail);
    case "percent":
      return w.percent(detail);
    case "over-100":
      return w["over-100"](detail);
    case "raise-size":
      return w["raise-size"](detail);
    case "too-big":
      return w["too-big"];
    default:
      return w.set(detail || code);
  }
}

export function ChartsScreen({
  source,
  title,
  titleTag: Title = "h1",
  notice,
  renderState,
  renderHandLink,
  selected,
  view,
  situation = null,
  period,
  onNavigate,
  hiddenDuringPlay = false,
}: ChartsScreenProps) {
  const ui = useUiStrings();
  const t = ui.charts;
  const [list, setList] = useState<{ items: ChartSummary[] } | { error: string } | null>(null);
  const [stored, setDraft] = useState<Draft>(null);
  const [blank] = useState(() => newChartSet({ name: t.library.newName }));
  // A new set in the address with no draft yet (a reload): a blank one.
  const draft: Draft =
    selected === NEW_SET && (!stored || stored.id !== null) ? { id: null, set: blank, dirty: true, token: 0 } : stored;
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ kind: "saving" | "saved" | "error"; text: string } | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (hiddenDuringPlay) return;
    let live = true;
    source.list().then(
      (items) => live && setList({ items }),
      (error) => live && setList({ error: errorText(error) }),
    );
    return () => {
      live = false;
    };
  }, [source, reload, hiddenDuringPlay]);

  // The open set: a new one, or loaded by id (kept while it is the same).
  useEffect(() => {
    if (hiddenDuringPlay || selected === null || selected === NEW_SET) return;
    let live = true;
    source.load(selected).then(
      (set) => {
        if (!live) return;
        setLoadError(null);
        setDraft((current) =>
          current && current.id === selected ? current : { id: selected, set, dirty: false, token: nextToken++ },
        );
      },
      (error) => live && setLoadError(errorText(error)),
    );
    return () => {
      live = false;
    };
  }, [selected, source, hiddenDuringPlay]);

  const problemText = useCallback((p: ChartProblem) => chartProblemText(t, p.code, p.detail), [t]);

  const save = async () => {
    if (!draft) return;
    const stray = new Set(strayKeys(draft.set));
    const cleaned: ChartSet = { ...draft.set, name: draft.set.name.trim(), nodes: new Map([...draft.set.nodes].filter(([k]) => !stray.has(k))) };
    const found = validateChartSet(cleaned);
    if (found.length > 0) {
      setProblems(found.map(problemText));
      return;
    }
    setProblems([]);
    setStatus({ kind: "saving", text: t.tools.saving });
    try {
      const saved = await source.save({ ...cleaned, id: draft.id });
      const set = { ...cleaned, id: saved.id, updatedAt: saved.updatedAt };
      setDraft({ id: saved.id, set, dirty: false, token: draft.token });
      setStatus({ kind: "saved", text: t.tools.saved });
      setReload((n) => n + 1);
      if (draft.id === null && saved.id) onNavigate({ selected: saved.id, view });
    } catch (error) {
      setStatus({ kind: "error", text: t.error(errorText(error)) });
    }
  };

  const remove = async () => {
    if (!draft) return;
    if (draft.id !== null) {
      if (typeof window !== "undefined" && !window.confirm(t.tools.deleteConfirm(draft.set.name))) return;
      try {
        await source.remove(draft.id);
      } catch (error) {
        setStatus({ kind: "error", text: t.error(errorText(error)) });
        return;
      }
    }
    setDraft(null);
    setReload((n) => n + 1);
    onNavigate({ selected: null, view: "edit" });
  };

  const download = () => {
    if (!draft || typeof document === "undefined") return;
    const blob = new Blob([exportRailJsonText(draft.set)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${draft.set.name.trim().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "charts"}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  let body: ReactNode;
  if (hiddenDuringPlay) {
    body = <p className={styles.notice}>{t.hiddenDuringPlay}</p>;
  } else if (selected === null) {
    body = (
      <Library
        list={list}
        renderState={renderState}
        onOpen={(id) => onNavigate({ selected: id, view: "edit" })}
        onCreate={() => {
          setDraft({ id: null, set: newChartSet({ name: t.library.newName }), dirty: true, token: nextToken++ });
          onNavigate({ selected: NEW_SET, view: "edit" });
        }}
        onImported={(set) => {
          setDraft({ id: null, set, dirty: true, token: nextToken++ });
          setStatus({ kind: "saved", text: t.library.imported(set.name) });
          onNavigate({ selected: NEW_SET, view: "edit" });
        }}
      />
    );
  } else if (loadError) {
    body = renderState("error", t.error(loadError));
  } else if (!draft || (selected !== NEW_SET && draft.id !== selected)) {
    body = renderState("loading", t.loading);
  } else {
    const tab = draft.id === null ? "edit" : view;
    body = (
      <div className={styles.body}>
        <div className={styles.setHead}>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => onNavigate({ selected: null, view: "edit" })}>
            ← {t.back}
          </button>
          <h2 className={styles.setName}>{draft.set.name || t.library.newName}</h2>
        </div>
        <div className={styles.tabs} role="tablist" aria-label={t.tabs.label}>
          {(["edit", "compare"] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              id={`charts-tab-${v}`}
              aria-controls="charts-panel"
              aria-selected={tab === v}
              disabled={v === "compare" && draft.id === null}
              className={`${styles.tab}${tab === v ? ` ${styles.tabActive}` : ""}`}
              onClick={() => onNavigate({ selected, view: v })}
            >
              {t.tabs[v]}
            </button>
          ))}
        </div>
        <div id="charts-panel" role="tabpanel" aria-labelledby={`charts-tab-${tab}`}>
          {tab === "edit" ? (
            <>
              <ChartEditor
                key={`${draft.token}|${situation ?? ""}`}
                set={draft.set}
                source={source}
                initialKey={situation}
                onChange={(set) => {
                  setDraft({ ...draft, set, dirty: true });
                  setStatus(null);
                }}
              />
              <div className={styles.saveBar}>
                <button type="button" className="btn btn--primary" disabled={status?.kind === "saving"} onClick={() => void save()}>
                  {t.tools.save}
                </button>
                <button type="button" className="btn" onClick={download}>
                  {t.tools.download}
                </button>
                <button type="button" className="btn btn--ghost" onClick={() => void remove()}>
                  {t.tools.delete}
                </button>
                <span className={styles.muted} role="status">
                  {status ? status.text : draft.dirty ? t.tools.unsaved : ""}
                </span>
              </div>
              {problems.length > 0 ? (
                <ul className={styles.problems} role="alert">
                  {problems.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : (
            <ChartCompare
              set={draft.set}
              source={source}
              renderHandLink={renderHandLink}
              period={period}
              onPeriod={(next) => onNavigate({ selected, view: "compare", period: next })}
              onFill={(key) => onNavigate({ selected, view: "edit", situation: key })}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.screen}>
      <header className={styles.top}>
        <Title className={styles.title}>{title}</Title>
        <p className={styles.intro}>{t.intro}</p>
      </header>
      {notice}
      {body}
    </div>
  );
}

function Library({
  list,
  renderState,
  onOpen,
  onCreate,
  onImported,
}: {
  list: { items: ChartSummary[] } | { error: string } | null;
  renderState: ChartsScreenProps["renderState"];
  onOpen: (id: string) => void;
  onCreate: () => void;
  onImported: (set: ChartSet) => void;
}) {
  const ui = useUiStrings();
  const t = ui.charts;
  const when = dateFormat(ui.intlLocale, { day: "numeric", month: "short", year: "numeric" });
  const [text, setText] = useState("");
  const [problems, setProblems] = useState<ImportProblem[]>([]);

  const problemText = (p: ImportProblem): string => {
    switch (p.code) {
      case "json":
        return t.problems.json(p.detail);
      case "format":
        return t.problems.format;
      case "version":
        return t.problems.version(p.detail);
      case "game":
        return t.problems.game;
      case "duplicate":
        return t.problems.duplicate(p.where);
      case "range":
        return t.problems.range(p.where, p.detail);
      case "over-100":
        return t.problems["over-100"](`${p.where} ${p.detail}`);
      case "node-key":
        return t.problems["node-key"](p.where);
      case "too-big":
        return t.problems["too-big"];
      default:
        return chartProblemText(t, p.where, p.detail);
    }
  };

  const read = (content: string) => {
    const result = importRailJson(content);
    if (!result.ok) {
      setProblems(result.problems);
      return;
    }
    setProblems([]);
    onImported(result.value);
  };

  if (list === null) return <>{renderState("loading", t.loading)}</>;
  if ("error" in list) return <>{renderState("error", t.error(list.error))}</>;
  const full = list.items.length >= LIMITS.sets;

  return (
    <div className={styles.body}>
      <section className={styles.card} aria-labelledby="charts-library">
        <div className={styles.cardHead}>
          <h2 id="charts-library" className={styles.cardTitle}>
            {t.library.heading}
          </h2>
          <button type="button" className="btn btn--primary" disabled={full} onClick={onCreate}>
            {t.library.create}
          </button>
        </div>
        {full ? <p className={styles.warning}>{t.library.limit(LIMITS.sets)}</p> : null}
        {list.items.length === 0 ? <p className={styles.muted}>{t.library.empty}</p> : null}
        {list.items.length > 0 ? (
          <ul className={styles.sets}>
            {list.items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={styles.setRow}
                  aria-label={t.library.open(item.name)}
                  onClick={() => onOpen(item.id)}
                >
                  <span className={styles.setRowName}>{item.name}</span>
                  <span className={styles.muted}>
                    {t.library.summary(
                      ui.charts.game.formats[item.gameFormat],
                      ui.charts.game.tablesShort[item.tableSize],
                      item.stackMinBb,
                      item.stackMaxBb,
                      item.nodes,
                    )}
                  </span>
                  <span className={styles.muted}>{t.library.updated(when.format(new Date(item.updatedAt)))}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className={styles.card} aria-labelledby="charts-import">
        <h2 id="charts-import" className={styles.cardTitle}>
          {t.library.importHeading}
        </h2>
        <p className={styles.muted}>{t.library.importHelp}</p>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t.library.importFile}</span>
          <input
            type="file"
            accept=".json,application/json"
            disabled={full}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (file) read(await file.text());
              event.target.value = "";
            }}
          />
        </label>
        <label className={`${styles.field} ${styles.fieldFull}`}>
          <span className={styles.fieldLabel}>{t.library.importPaste}</span>
          <textarea rows={4} spellCheck={false} value={text} onChange={(event) => setText(event.target.value)} />
        </label>
        <div>
          <button type="button" className="btn" disabled={full || text.trim() === ""} onClick={() => read(text)}>
            {t.library.importButton}
          </button>
        </div>
        {problems.length > 0 ? (
          <ul className={styles.problems} role="alert">
            {problems.slice(0, 10).map((p, i) => (
              <li key={i}>{problemText(p)}</li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
