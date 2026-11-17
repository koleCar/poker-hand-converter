/**
 * My nodelocks (`docs/NODELOCK.md` §5.5): every lock solved on this
 * computer, newest first, in the Solver tab beside the library
 * (`#/solver/locks`). A solve running shows its progress on top. A row says
 * what was locked, where, how and how well; a click opens a solved one on its
 * spot, still in My nodelocks (`#/solver/lock=<id>&…`). Search, a spot filter, rename,
 * duplicate and edit, delete (one or the selected), all local.
 */
import { CardRow } from "@rail/ui/cards/PlayingCard";
import { Dialog } from "@rail/ui/dialog/Dialog";
import { Icon } from "@rail/ui/icon/Icon";
import { RailLoader } from "@rail/ui/loader/RailLoader";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useLocale, useT } from "../../i18n";
import { liveDateFormat } from "../../i18n/format";
import { go } from "../../lib/router";
import { nodelockSuggestEn, nodelockSuggestHr, type Archetype } from "../door";
import { nodelockData, onNodelocksChanged, type NodeLockRow } from "./data";
import styles from "./nodelock.module.css";
import { editLock, LOCKS_PARAM, openLock, parseRow, useNodelockSession } from "./session";
import { SolveProgress } from "./slot";

const DATE = liveDateFormat({ day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A spot's key for the filter: the table, the line and the flop. */
function spotOf(row: NodeLockRow): string {
  return `${row.set_id}/${row.line}/${row.flop}`;
}

type Loaded = { status: "loading" } | { status: "error" } | { status: "ready"; rows: NodeLockRow[] };

export function History({ libraryParam }: { libraryParam: string | null }) {
  const t = useT().nodelock;
  const locale = useLocale();
  const names = (locale === "hr" ? nodelockSuggestHr : nodelockSuggestEn).names;
  const session = useNodelockSession();
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [query, setQuery] = useState("");
  const [spot, setSpot] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const read = useCallback(() => {
    nodelockData.list().then(
      (rows) => setLoaded({ status: "ready", rows: [...rows].sort((a, b) => b.updated_at - a.updated_at) }),
      () => setLoaded({ status: "error" }),
    );
  }, []);
  useEffect(() => {
    read();
    return onNodelocksChanged(read);
  }, [read, attempt]);
  // A solve finishing (or starting) changes a row's status.
  useEffect(() => {
    read();
  }, [read, session.running?.id, session.notice?.id]);

  const rows = useMemo(() => (loaded.status === "ready" ? loaded.rows : []), [loaded]);
  const spots = useMemo(() => [...new Set(rows.map(spotOf))].sort(), [rows]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (spot && spotOf(row) !== spot) return false;
      if (!q) return true;
      const summary = parseRow(row)?.summary;
      const text = [row.name, row.set_id, row.line, row.flop, summary?.view.flop ?? "", row.node_path, row.preset ?? ""].join(" ").toLowerCase();
      return text.includes(q);
    });
  }, [rows, query, spot]);

  if (loaded.status === "loading") return <RailLoader label={t.mine} centered />;
  if (loaded.status === "error") {
    return (
      <div className={styles.empty}>
        <p>{t.loadError}</p>
        <button type="button" className="btn btn--sm" onClick={() => setAttempt((n) => n + 1)}>
          {t.retry}
        </button>
      </div>
    );
  }
  const progress = session.running ? <SolveProgress running={session.running} /> : null;
  if (!rows.length) {
    return (
      <div className={styles.empty}>
        {progress}
        <p>{t.empty}</p>
        <a className={styles.link} href={`#/solver${libraryParam ? `/${encodeURIComponent(libraryParam)}` : ""}`}>
          {t.emptyLink}
        </a>
      </div>
    );
  }

  const allShown = shown.length > 0 && shown.every((row) => selected.has(row.id));
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  const open = async (row: NodeLockRow) => {
    setError(null);
    if (row.status !== "solved") return;
    if (!(await openLock(row.id))) setError(t.openError);
  };
  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await nodelockData.remove(deleting);
      setSelected(new Set([...selected].filter((id) => !deleting.includes(id))));
      setDeleting(null);
    } catch {
      setError(t.loadError);
    } finally {
      setBusy(false);
    }
  };
  const saveName = async () => {
    if (!renaming) return;
    const name = renaming.name.trim();
    if (name) await nodelockData.rename(renaming.id, name).catch(() => setError(t.loadError));
    setRenaming(null);
  };

  return (
    <div className={styles.history}>
      {progress}
      <div className={styles.historyBar}>
        <input
          type="search"
          className={styles.search}
          value={query}
          placeholder={t.search}
          aria-label={t.searchLabel}
          onChange={(event) => setQuery(event.target.value)}
        />
        {spots.length > 1 ? (
          <select className={styles.select} value={spot} aria-label={t.spotFilter} onChange={(event) => setSpot(event.target.value)}>
            <option value="">{t.allSpots}</option>
            {spots.map((key) => (
              <option key={key} value={key}>
                {key.split("/").slice(1).join(" · ")}
              </option>
            ))}
          </select>
        ) : null}
        {selected.size ? (
          <button type="button" className={`btn btn--sm ${styles.danger}`} onClick={() => setDeleting([...selected])}>
            {t.deleteSelected(selected.size)}
          </button>
        ) : null}
      </div>
      {error ? <p className={styles.error}>{error}</p> : null}

      {shown.length ? (
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.check}>
                <input
                  type="checkbox"
                  checked={allShown}
                  aria-label={t.selectAll}
                  onChange={() => setSelected(allShown ? new Set() : new Set(shown.map((row) => row.id)))}
                />
              </th>
              <th>{t.columns.name}</th>
              <th>{t.columns.spot}</th>
              <th>{t.columns.node}</th>
              <th>{t.columns.preset}</th>
              <th>{t.columns.date}</th>
              <th>{t.columns.status}</th>
              <th className={styles.num}>{t.columns.accuracy}</th>
              <th className={styles.num}>{t.columns.time}</th>
              <th>{t.columns.engine}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => {
              const summary = parseRow(row)?.summary ?? null;
              const flop = summary?.view.flop ?? row.flop;
              const cards = [flop.slice(0, 2), flop.slice(2, 4), flop.slice(4, 6)];
              const solved = row.status === "solved";
              const position = summary?.position ?? "";
              return (
                <tr
                  key={row.id}
                  className={`${styles.row} ${solved ? styles.rowOpen : ""} ${session.active?.row.id === row.id ? styles.rowActive : ""}`}
                  onClick={() => void open(row)}
                >
                  <td className={styles.check} onClick={(event) => event.stopPropagation()}>
                    <input type="checkbox" checked={selected.has(row.id)} aria-label={t.select(row.name)} onChange={() => toggle(row.id)} />
                  </td>
                  <td className={styles.nameCell}>
                    {renaming?.id === row.id ? (
                      <form
                        className={styles.rename}
                        onClick={(event) => event.stopPropagation()}
                        onSubmit={(event) => {
                          event.preventDefault();
                          void saveName();
                        }}
                      >
                        <input
                          autoFocus
                          value={renaming.name}
                          aria-label={t.renameLabel(row.name)}
                          onChange={(event) => setRenaming({ id: row.id, name: event.target.value })}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") setRenaming(null);
                          }}
                        />
                        <button type="submit" className="btn btn--sm">
                          {t.save}
                        </button>
                      </form>
                    ) : solved ? (
                      <button type="button" className={styles.nameButton} onClick={() => void open(row)}>
                        {row.name}
                      </button>
                    ) : (
                      <span>{row.name}</span>
                    )}
                  </td>
                  <td>
                    <span className={styles.spot}>
                      <CardRow cards={cards} size="xs" />
                      <span className={styles.muted}>
                        {summary ? `${summary.players[1]}–${summary.players[0]}` : row.line}
                      </span>
                    </span>
                  </td>
                  <td>{t.nodeAt(position, t.streets[row.street] ?? row.street, summary?.steps?.join(" · ") ?? "")}</td>
                  <td>{row.preset ? (names[row.preset as Archetype] ?? row.preset) : t.custom}</td>
                  <td className={styles.muted}>{DATE.format(row.created_at)}</td>
                  <td>
                    <span className={styles.status} data-status={row.status}>
                      {t.status[row.status] ?? row.status}
                    </span>
                  </td>
                  <td className={styles.num}>{row.exploitability_pct !== null ? `${Math.round(row.exploitability_pct * 100) / 100}%` : ""}</td>
                  <td className={styles.num}>{row.seconds !== null ? clock(row.seconds) : ""}</td>
                  <td className={styles.muted}>{row.engine ? (t.engines[row.engine] ?? row.engine) : ""}</td>
                  <td className={styles.rowTools} onClick={(event) => event.stopPropagation()}>
                    <button type="button" className="btn btn--sm btn--ghost" onClick={() => setRenaming({ id: row.id, name: row.name })}>
                      {t.rename}
                    </button>
                    <button type="button" className="btn btn--sm btn--ghost" onClick={() => editLock(row, t.copyName(row.name))}>
                      {t.duplicate}
                    </button>
                    <button type="button" className={`btn btn--sm btn--ghost ${styles.danger}`} onClick={() => setDeleting([row.id])}>
                      {t.delete}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className={styles.muted}>{t.noMatch}</p>
      )}

      {deleting ? (
        <Dialog title={t.deleteTitle(deleting.length)} onClose={() => setDeleting(null)}>
          <p className={styles.dialogBody}>{t.deleteBody(deleting.length)}</p>
          <div className={styles.dialogActions}>
            <button type="button" className="btn" disabled={busy} onClick={() => setDeleting(null)}>
              {t.keep}
            </button>
            <button type="button" className={`btn ${styles.dangerSolid}`} disabled={busy} onClick={() => void remove()}>
              {busy ? t.deleting : t.delete}
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

/**
 * The switch between the library (the clean solve) and My nodelocks, above
 * both: one joined pill like Cash | Tournaments, the active side filled. Each
 * side goes back to where it was left; a spinner while a lock is solving.
 */
export function SolverTabs({
  locks,
  libraryParam,
  locksParam,
  solving,
}: {
  locks: boolean;
  libraryParam: string | null;
  locksParam: string;
  solving: boolean;
}) {
  const t = useT().nodelock;
  return (
    <div className={styles.switch} role="tablist" aria-label={t.tabsLabel}>
      <button
        type="button"
        role="tab"
        aria-selected={!locks}
        className={styles.switchTab}
        title={t.libraryHint}
        onClick={() => {
          if (locks) go("solver", libraryParam);
        }}
      >
        {t.library}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={locks}
        className={styles.switchTab}
        title={t.mineHint}
        onClick={() => {
          if (!locks) go("solver", locksParam);
        }}
      >
        <Icon name="lock" />
        {t.mine}
        {solving ? <span className={styles.tabSpinner} aria-label={t.sidebarSolving} /> : null}
      </button>
    </div>
  );
}

export { LOCKS_PARAM };
