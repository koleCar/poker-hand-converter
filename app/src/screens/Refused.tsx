/**
 * Refused hands (R1.6; guideline §3 "ruke u karanteni"): every hand Rail
 * could not read - app-wide, or one folder's (`#/refused/<source id>`, from
 * the folder's pill in Settings) - with "Try again" for those an older
 * parser version refused, the reasons as chips with their counts, and the
 * hands as a table, 50 a page, each with its raw text. Not in the sidebar:
 * Settings, the folders' pills and the Import screen lead here.
 */
import { Icon } from "@rail/ui/icon/Icon";
import { RailLoader } from "@rail/ui/loader/RailLoader";
import { useCallback, useEffect, useState } from "react";

import { RefusedTable } from "../components/RefusedTable";
import { ScreenHeader } from "../components/ScreenHeader";
import { useT } from "../i18n";
import { liveNumberFormat } from "../i18n/format";
import {
  errorText,
  inApp,
  ipc,
  onWatcherChanged,
  type QuarantineList,
  type QuarantineSummary,
  type WatchSource,
} from "../lib/ipc";
import { REFUSED, replaceParam, screenHref, useRouteParam } from "../lib/router";
import { useWatcherStatus } from "../lib/useWatcherStatus";
import styles from "./Refused.module.css";
import s from "./settings/Settings.module.css";

/** Refused hands a page. */
export const PAGE_SIZE = 50;

const number = liveNumberFormat();

/**
 * The page buttons to show: the first, the last, and the current one with
 * its neighbours; `null` is a gap ("…"). Pages count from 0.
 */
export function pageList(current: number, pages: number): (number | null)[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, page) => page);
  const wanted = new Set([0, pages - 1, current - 1, current, current + 1].filter((page) => page >= 0 && page < pages));
  const sorted = [...wanted].sort((a, b) => a - b);
  const list: (number | null)[] = [];
  for (const page of sorted) {
    const last = list[list.length - 1];
    if (typeof last === "number" && page - last > 1) list.push(null);
    list.push(page);
  }
  return list;
}

function sourceLabel(source: WatchSource): string {
  const room = source.siteName ?? source.siteOverride;
  return room ? `${room} · ${source.path}` : source.path;
}

export function Refused() {
  const t = useT();
  const param = useRouteParam();
  const sourceId = param !== null && /^\d+$/.test(param) ? Number(param) : null;
  return (
    <>
      <a className={styles.back} href={screenHref("settings", "folders")}>
        <Icon name="chevronLeft" />
        {t.nav.settings}
      </a>
      <ScreenHeader title={t.refused.heading} />
      {inApp ? (
        // A folder of its own starts again from all reasons and the first page.
        <RefusedHands key={sourceId ?? "all"} sourceId={sourceId} />
      ) : (
        <p className={s.muted}>{t.settings.unavailable}</p>
      )}
    </>
  );
}

function RefusedHands({ sourceId }: { sourceId: number | null }) {
  const t = useT();
  const d = t.refused;
  const { status } = useWatcherStatus();
  const [summary, setSummary] = useState<QuarantineSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  // The page as loaded, with what it was loaded for.
  const [loaded, setLoaded] = useState<{ key: string; list: QuarantineList | null; error: string | null } | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [result, setResult] = useState<{ text: string; error: boolean } | null>(null);

  const load = useCallback(() => {
    ipc
      .quarantineSummary(sourceId)
      .then((next) => {
        setSummary(next);
        setError(null);
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, [sourceId]);

  useEffect(() => {
    load();
    return onWatcherChanged(load);
  }, [load]);

  // How many match the chosen reason; past the last page (fewer hands
  // after a retry), the last page is shown.
  const total = summary?.total ?? null;
  const matching = reason === null ? (total ?? 0) : (summary?.reasons.find((r) => r.reason === reason)?.count ?? 0);
  const current = Math.min(page, Math.max(0, Math.ceil(matching / PAGE_SIZE) - 1));

  // A new total (hands read again, new ones refused) reloads the page shown.
  const key = `${reason ?? ""}|${current}|${total ?? ""}`;
  useEffect(() => {
    if (total === null) return;
    let live = true;
    ipc
      .quarantineEntries(sourceId, reason, { offset: current * PAGE_SIZE, limit: PAGE_SIZE })
      .then((list) => live && setLoaded({ key, list, error: null }))
      .catch((e: unknown) => live && setLoaded({ key, list: null, error: errorText(e) }));
    return () => {
      live = false;
    };
  }, [sourceId, reason, current, total, key]);

  // While the next page loads, the last one stays (no flicker); its error is the current one's only.
  const list = loaded?.list ?? null;
  const listError = loaded?.key === key ? loaded.error : null;

  const retry = async () => {
    setRetrying(true);
    setResult(null);
    try {
      const files = await ipc.retryRefused(sourceId);
      setResult({ text: d.retried(files), error: false });
      load();
    } catch (e: unknown) {
      setResult({ text: d.retryFailed(errorText(e)), error: true });
    } finally {
      setRetrying(false);
    }
  };

  const choose = (next: string | null) => {
    setReason(next);
    setPage(0);
  };

  const sources = (status?.sources ?? []).filter((source) => source.quarantined > 0 || source.id === sourceId);

  if (error) return <p className={s.error}>{d.loadFailed(error)}</p>;
  if (!summary) return <RailLoader size="inline" label={d.loading} showLabel />;

  return (
    <div className={styles.page}>
      {summary.retryable.hands > 0 && (
        <div className={s.card}>
          <div className={`${s.row} ${s.rowWide}`}>
            <span className={s.strong}>{d.olderParser(summary.retryable.hands)}</span>
            <span className={s.actions}>
              <button
                type="button"
                className="btn btn--primary btn--sm"
                disabled={retrying}
                onClick={() => void retry()}
              >
                {retrying ? d.retrying : d.tryAgain}
              </button>
            </span>
          </div>
        </div>
      )}
      <div className={s.live} aria-live="polite">
        {result && <p className={`${s.note} ${result.error ? s.error : s.success}`}>{result.text}</p>}
      </div>

      <div className={styles.filters}>
        <div className={styles.chips} role="group" aria-label={d.reasons}>
          <button type="button" className={styles.chip} aria-pressed={reason === null} onClick={() => choose(null)}>
            {d.all}
            <span className={styles.count}>{number.format(summary.total)}</span>
          </button>
          {summary.reasons.map((item) => (
            <button
              key={item.reason}
              type="button"
              className={styles.chip}
              aria-pressed={item.reason === reason}
              onClick={() => choose(item.reason)}
            >
              <code>{item.reason}</code>
              <span className={styles.count}>{number.format(item.count)}</span>
            </button>
          ))}
        </div>
        {(sources.length > 1 || sourceId !== null) && (
          <select
            className={styles.select}
            aria-label={d.folder}
            value={sourceId === null ? "" : String(sourceId)}
            onChange={(event) => replaceParam(REFUSED, event.target.value === "" ? null : event.target.value)}
          >
            <option value="">{d.allFolders}</option>
            {sources.map((source) => (
              <option key={source.id} value={String(source.id)}>
                {sourceLabel(source)}
              </option>
            ))}
          </select>
        )}
      </div>

      {summary.total === 0 ? (
        <p className={s.muted}>{d.none}</p>
      ) : (
        <div className={s.card}>
          {listError && (
            <div className={`${s.row} ${s.rowWide}`}>
              <p className={s.error}>{d.loadFailed(listError)}</p>
            </div>
          )}
          {!list && !listError && (
            <div className={`${s.row} ${s.rowWide}`}>
              <RailLoader size="inline" label={d.loading} showLabel />
            </div>
          )}
          {list && list.entries.length === 0 && !listError && (
            <div className={`${s.row} ${s.rowWide}`}>
              <p className={s.muted}>{d.none}</p>
            </div>
          )}
          {list && list.entries.length > 0 && <RefusedTable entries={list.entries} />}
        </div>
      )}

      {matching > PAGE_SIZE && <Pagination page={current} total={matching} onPage={setPage} />}
    </div>
  );
}

/** "1–50 of 120" and the page buttons with ‹ ›, at the bottom right. */
function Pagination({ page, total, onPage }: { page: number; total: number; onPage: (page: number) => void }) {
  const d = useT().refused;
  const pages = Math.ceil(total / PAGE_SIZE);
  const from = page * PAGE_SIZE + 1;
  const to = Math.min(total, (page + 1) * PAGE_SIZE);
  return (
    <nav className={styles.pagination} aria-label={d.pages}>
      <span className={s.muted}>{d.range(from, to, total)}</span>
      <button
        type="button"
        className={styles.pageButton}
        aria-label={d.previous}
        disabled={page === 0}
        onClick={() => onPage(page - 1)}
      >
        <Icon name="chevronLeft" />
      </button>
      {pageList(page, pages).map((item, index) =>
        item === null ? (
          <span key={`gap-${index}`} className={styles.gap} aria-hidden="true">
            …
          </span>
        ) : (
          <button
            key={item}
            type="button"
            className={styles.pageButton}
            aria-label={d.page(item + 1)}
            aria-current={item === page ? "page" : undefined}
            onClick={() => onPage(item)}
          >
            {item + 1}
          </button>
        ),
      )}
      <button
        type="button"
        className={styles.pageButton}
        aria-label={d.next}
        disabled={page >= pages - 1}
        onClick={() => onPage(page + 1)}
      >
        <Icon name="chevronRight" />
      </button>
    </nav>
  );
}
