"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, useCallback, useEffect, useState } from "react";
import { RailLoader } from "@rail/ui/loader/RailLoader";
import {
  adminFeedback,
  adminFeedbackCounts,
  adminSetFeedbackStatus,
  feedbackImageUrls,
  isAdminRefusal,
  type AdminFeedbackRow,
  type FeedbackCounts,
  type FeedbackKind,
  type FeedbackStatus,
} from "../../lib/db/admin";
import { useDict } from "../../lib/i18n/client";
import { paths } from "../../lib/routes";
import { AdminError } from "./AdminShell";
import { KindBadge, StatusBadge } from "./badges";
import { useAdminFormat } from "./format";
import { Pager } from "./Pager";
import styles from "./admin.module.css";

const PAGE = 50;
const STATUSES: readonly FeedbackStatus[] = ["new", "read", "done", "spam"];
const KINDS: readonly FeedbackKind[] = ["bug", "feature", "question"];

type Load =
  | { status: "loading" }
  | { status: "ready"; rows: AdminFeedbackRow[] }
  | { status: "error"; denied: boolean; reason: string };

/**
 * The feedback reports, newest first: filtered by status (with counts), by
 * kind, and by account (`?user=`, from an account's page). A row opens in
 * place with the whole text, the screenshots and where it was sent from; a
 * new report becomes "read" when it is opened.
 */
export function ReportsTable() {
  const dict = useDict().admin;
  const t = dict.reports;
  const loadingLabel = dict.loading;
  const fmt = useAdminFormat();
  const router = useRouter();
  const pathname = usePathname() ?? paths.adminReports();
  const params = useSearchParams();

  const statusParam = params.get("status");
  // New reports first: the inbox. `all` shows every status.
  const status: FeedbackStatus | null =
    statusParam === "all" ? null : STATUSES.includes(statusParam as FeedbackStatus) ? (statusParam as FeedbackStatus) : params.get("user") ? null : "new";
  const kindParam = params.get("kind");
  const kind = KINDS.includes(kindParam as FeedbackKind) ? (kindParam as FeedbackKind) : null;
  const user = params.get("user");
  const page = Math.max(0, Number(params.get("page") ?? "0") || 0);

  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [counts, setCounts] = useState<FeedbackCounts | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [saveError, setSaveError] = useState(false);

  const navigate = useCallback(
    (next: { status?: FeedbackStatus | "all"; kind?: FeedbackKind | null; user?: string | null; page?: number }) => {
      const query = new URLSearchParams();
      const nstatus = next.status !== undefined ? next.status : (status ?? "all");
      const nkind = next.kind !== undefined ? next.kind : kind;
      const nuser = next.user !== undefined ? next.user : user;
      if (nuser) query.set("user", nuser);
      if (nstatus !== (nuser ? "all" : "new")) query.set("status", nstatus);
      if (nkind) query.set("kind", nkind);
      if (next.page) query.set("page", String(next.page));
      const search = query.toString();
      router.replace(search ? `${pathname}?${search}` : pathname, { scroll: false });
    },
    [kind, pathname, router, status, user],
  );

  useEffect(() => {
    let current = true;
    Promise.all([adminFeedback({ status, kind, user, limit: PAGE, offset: page * PAGE }), adminFeedbackCounts()])
      .then(([rows, nextCounts]) => {
        if (!current) return;
        setLoad({ status: "ready", rows });
        setCounts(nextCounts);
        // A link from an account's page names a report: open it.
        const hash = window.location.hash.slice(1);
        if (hash && rows.some((row) => row.id === hash)) setOpen(hash);
      })
      .catch((error: unknown) => {
        if (!current) return;
        setLoad({ status: "error", denied: isAdminRefusal(error), reason: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      current = false;
    };
  }, [status, kind, user, page, attempt]);

  const setStatus = useCallback((row: AdminFeedbackRow, next: FeedbackStatus) => {
    if (row.status === next) return;
    const was = row.status;
    const apply = (value: FeedbackStatus) => {
      setLoad((current) =>
        current.status === "ready"
          ? { status: "ready", rows: current.rows.map((r) => (r.id === row.id ? { ...r, status: value } : r)) }
          : current,
      );
      setCounts((current) =>
        current ? { ...current, [row.status]: current[row.status] - 1, [value]: current[value] + 1 } : current,
      );
    };
    setSaveError(false);
    apply(next);
    adminSetFeedbackStatus(row.id, next).catch(() => {
      setSaveError(true);
      setLoad((current) =>
        current.status === "ready"
          ? { status: "ready", rows: current.rows.map((r) => (r.id === row.id ? { ...r, status: was } : r)) }
          : current,
      );
      setCounts((current) => (current ? { ...current, [next]: current[next] - 1, [was]: current[was] + 1 } : current));
    });
  }, []);

  if (load.status === "error") {
    return <AdminError denied={load.denied} reason={load.reason} onRetry={() => setAttempt((a) => a + 1)} />;
  }
  const rows = load.status === "ready" ? load.rows : [];
  const total = rows[0]?.total ?? 0;
  const userRow = user ? rows.find((row) => row.user_id === user) : undefined;

  return (
    <section className={styles.panel}>
      <div className={styles.toolbar}>
        <div className={styles.segmented} role="group" aria-label={t.statusLabel}>
          {(["new", "read", "done", "spam", "all"] as const).map((value) => {
            const on = (status ?? "all") === value;
            return (
              <button
                key={value}
                type="button"
                className={on ? `${styles.segment} ${styles.segmentOn}` : styles.segment}
                aria-pressed={on}
                onClick={() => navigate({ status: value, page: 0 })}
              >
                {t.status[value]}
                {counts ? <span className={styles.segmentCount}>{fmt.number(counts[value])}</span> : null}
              </button>
            );
          })}
        </div>
        <div className={styles.segmented} role="group" aria-label={t.kindLabel}>
          {([null, ...KINDS] as const).map((value) => {
            const on = kind === value;
            return (
              <button
                key={value ?? "all"}
                type="button"
                className={on ? `${styles.segment} ${styles.segmentOn}` : styles.segment}
                aria-pressed={on}
                onClick={() => navigate({ kind: value, page: 0 })}
              >
                {t.kind[value ?? "all"]}
              </button>
            );
          })}
        </div>
        {user ? (
          <span className={styles.filterChip}>
            {t.forUser(userRow?.username ?? userRow?.user_email ?? user.slice(0, 8))}
            <button type="button" onClick={() => navigate({ user: null, status: "new", page: 0 })} aria-label={t.clearUser} title={t.clearUser}>
              ×
            </button>
          </span>
        ) : null}
      </div>

      {saveError ? (
        <p className={styles.error} role="alert">
          {t.setError}
        </p>
      ) : null}

      {load.status === "loading" ? (
        <RailLoader label={loadingLabel} />
      ) : rows.length === 0 ? (
        <p className={styles.state}>{t.empty}</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={`${styles.table} ${styles.reportsTable}`}>
            <thead>
              <tr>
                <th>{t.columns.report}</th>
                <th>{t.columns.from}</th>
                <th>{t.columns.where}</th>
                <th>{t.columns.when}</th>
                <th>{t.columns.status}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const expanded = open === row.id;
                return (
                  <Fragment key={row.id}>
                    <tr
                      id={row.id}
                      className={expanded ? `${styles.row} ${styles.rowOpen}` : row.status === "new" ? `${styles.row} ${styles.rowNew}` : styles.row}
                      onClick={() => {
                        setOpen(expanded ? null : row.id);
                        if (!expanded && row.status === "new") setStatus(row, "read");
                      }}
                      aria-expanded={expanded}
                    >
                      <td className={styles.reportCell}>
                        <KindBadge kind={row.kind} />
                        <span className={styles.reportText}>{row.message}</span>
                        {row.images.length > 0 ? <span className={styles.imageCount}>{t.images(row.images.length)}</span> : null}
                      </td>
                      <td>
                        {row.user_id ? (
                          <Link href={paths.adminUser(row.user_id)} onClick={(event) => event.stopPropagation()}>
                            {row.username ?? row.user_email}
                          </Link>
                        ) : (
                          <span className={styles.dim}>{row.email ?? t.visitor}</span>
                        )}
                      </td>
                      <td className={styles.where}>
                        <span className={styles.badge}>{t.sources[row.source] ?? row.source}</span>
                        <span className={styles.dim}>{row.page}</span>
                      </td>
                      <td className={styles.when}>{fmt.ago(row.created_at)}</td>
                      <td>
                        <StatusBadge status={row.status} />
                      </td>
                    </tr>
                    {expanded ? (
                      <tr className={styles.detailRow}>
                        <td colSpan={5}>
                          <ReportDetail row={row} onStatus={(next) => setStatus(row, next)} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {load.status === "ready" && total > PAGE ? (
        <Pager offset={page * PAGE} size={rows.length} total={total} onPage={(delta) => navigate({ page: page + delta })} />
      ) : null}
    </section>
  );
}

function ReportDetail({ row, onStatus }: { row: AdminFeedbackRow; onStatus: (status: FeedbackStatus) => void }) {
  const t = useDict().admin.reports;
  const fmt = useAdminFormat();
  const d = t.detail;
  const [images, setImages] = useState<{ status: "loading" } | { status: "ready"; urls: string[] } | { status: "error" }>(
    row.images.length > 0 ? { status: "loading" } : { status: "ready", urls: [] },
  );

  useEffect(() => {
    if (row.images.length === 0) return;
    let current = true;
    feedbackImageUrls(row.images)
      .then((urls) => current && setImages({ status: "ready", urls }))
      .catch(() => current && setImages({ status: "error" }));
    return () => {
      current = false;
    };
  }, [row.images]);

  return (
    <div className={styles.detail}>
      <p className={styles.message}>{row.message}</p>

      {images.status === "loading" ? (
        <p className={styles.dim}>{d.imagesLoading}</p>
      ) : images.status === "error" ? (
        <p className={styles.error}>{d.imagesError}</p>
      ) : images.urls.length > 0 ? (
        <div className={styles.shots}>
          {images.urls.map((url, index) => (
            <a key={url} href={url} target="_blank" rel="noreferrer" className={styles.shot} title={d.openImage(index + 1)}>
              <img src={url} alt={d.openImage(index + 1)} />
            </a>
          ))}
        </div>
      ) : null}

      <dl className={styles.meta}>
        {row.user_id ? (
          <div>
            <dt>{d.account}</dt>
            <dd>
              <Link href={paths.adminUser(row.user_id)}>{row.username ?? row.user_email}</Link>
              {row.user_email ? <span className={styles.dim}> · {row.user_email}</span> : null}
            </dd>
          </div>
        ) : null}
        {row.email ? (
          <div>
            <dt>{d.replyTo}</dt>
            <dd>
              <a href={`mailto:${row.email}`}>{row.email}</a>
            </dd>
          </div>
        ) : null}
        <div>
          <dt>{d.page}</dt>
          <dd>
            {t.sources[row.source] ?? row.source} · {row.page ?? "—"}
          </dd>
        </div>
        {row.app_version ? (
          <div>
            <dt>{d.version}</dt>
            <dd>{row.app_version}</dd>
          </div>
        ) : null}
        {row.platform ? (
          <div>
            <dt>{d.platform}</dt>
            <dd className={styles.platform}>{row.platform}</dd>
          </div>
        ) : null}
        {row.locale ? (
          <div>
            <dt>{d.locale}</dt>
            <dd>{row.locale}</dd>
          </div>
        ) : null}
        <div>
          <dt>{t.columns.when}</dt>
          <dd>{fmt.dateTime(row.created_at)}</dd>
        </div>
      </dl>

      <div className={styles.actions}>
        <span className={styles.dim}>{d.mark}</span>
        {STATUSES.map((value) => (
          <button
            key={value}
            type="button"
            className={value === row.status ? "btn btn--sm btn--primary" : "btn btn--sm btn--ghost"}
            aria-pressed={value === row.status}
            onClick={() => onStatus(value)}
          >
            {t.status[value]}
          </button>
        ))}
      </div>
    </div>
  );
}
