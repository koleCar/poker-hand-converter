"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { RailLoader } from "@rail/ui/loader/RailLoader";
import { adminUsers, isAdminRefusal, type AdminUserRow, type UserSort } from "../../lib/db/admin";
import { useDict } from "../../lib/i18n/client";
import { paths } from "../../lib/routes";
import { AdminError } from "./AdminShell";
import { Pager } from "./Pager";
import { useAdminFormat } from "./format";
import styles from "./admin.module.css";

const PAGE = 50;
const SORTS: readonly UserSort[] = ["created", "signed_in", "hands", "last_hand", "posts", "feedback", "email", "username"];
/** Text columns start A→Z; numbers and dates start with the largest / newest. */
const ASCENDING_FIRST: ReadonlySet<UserSort> = new Set(["email", "username"]);

type Column = { key: keyof ReturnType<typeof useDict>["admin"]["users"]["columns"]; sort: UserSort | null; numeric?: true };
const COLUMNS: Column[] = [
  { key: "user", sort: "username" },
  { key: "plan", sort: null },
  { key: "hands", sort: "hands", numeric: true },
  { key: "lastHand", sort: "last_hand" },
  { key: "posts", sort: "posts", numeric: true },
  { key: "feedback", sort: "feedback", numeric: true },
  { key: "created", sort: "created" },
  { key: "signedIn", sort: "signed_in" },
];

type Load = { status: "loading" } | { status: "ready"; rows: AdminUserRow[] } | { status: "error"; denied: boolean; reason: string };

/**
 * Every account: search (email, username or an id), sort by a column, 50 a
 * page. The query lives in the URL, so the back button from an account's page
 * returns to the same list.
 */
export function UsersTable() {
  const t = useDict().admin;
  const fmt = useAdminFormat();
  const router = useRouter();
  const pathname = usePathname() ?? paths.admin();
  const params = useSearchParams();

  const q = params.get("q") ?? "";
  const sortParam = params.get("sort") as UserSort | null;
  const sort: UserSort = sortParam && SORTS.includes(sortParam) ? sortParam : "created";
  const desc = params.get("dir") ? params.get("dir") === "desc" : !ASCENDING_FIRST.has(sort);
  const page = Math.max(0, Number(params.get("page") ?? "0") || 0);

  const [draft, setDraft] = useState(q);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  const navigate = useCallback(
    (next: { q?: string; sort?: UserSort; desc?: boolean; page?: number }) => {
      const query = new URLSearchParams();
      const nq = next.q ?? q;
      const nsort = next.sort ?? sort;
      const ndesc = next.desc ?? desc;
      const npage = next.page ?? 0;
      if (nq) query.set("q", nq);
      if (nsort !== "created") query.set("sort", nsort);
      if (ndesc !== !ASCENDING_FIRST.has(nsort)) query.set("dir", ndesc ? "desc" : "asc");
      if (npage > 0) query.set("page", String(npage));
      const search = query.toString();
      router.replace(search ? `${pathname}?${search}` : pathname, { scroll: false });
    },
    [desc, pathname, q, router, sort],
  );

  // The search box writes to the URL a beat after the last key.
  useEffect(() => {
    if (draft.trim() === q) return;
    const timer = window.setTimeout(() => navigate({ q: draft.trim() }), 250);
    return () => window.clearTimeout(timer);
  }, [draft, navigate, q]);

  useEffect(() => {
    let current = true;
    adminUsers({ search: q, sort, desc, limit: PAGE, offset: page * PAGE })
      .then((rows) => current && setLoad({ status: "ready", rows }))
      .catch((error: unknown) => {
        if (!current) return;
        setLoad({
          status: "error",
          denied: isAdminRefusal(error),
          reason: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      current = false;
    };
  }, [q, sort, desc, page, attempt]);

  if (load.status === "error") {
    return <AdminError denied={load.denied} reason={load.reason} onRetry={() => setAttempt((a) => a + 1)} />;
  }
  const rows = load.status === "ready" ? load.rows : [];
  const total = rows[0]?.total ?? 0;

  return (
    <section className={styles.panel}>
      <div className={styles.toolbar}>
        <input
          type="search"
          className={styles.search}
          placeholder={t.users.search}
          aria-label={t.users.search}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        {load.status === "ready" ? <span className={styles.count}>{t.users.count(total)}</span> : null}
      </div>

      {load.status === "loading" ? (
        <RailLoader label={t.loading} />
      ) : rows.length === 0 ? (
        <p className={styles.state}>{t.users.empty}</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                {COLUMNS.map((column) => {
                  const label = t.users.columns[column.key];
                  const active = column.sort === sort;
                  return (
                    <th
                      key={column.key}
                      className={column.numeric ? styles.num : undefined}
                      aria-sort={active ? (desc ? "descending" : "ascending") : undefined}
                    >
                      {column.sort ? (
                        <button
                          type="button"
                          className={active ? `${styles.sort} ${styles.sortOn}` : styles.sort}
                          title={t.users.sortBy(label)}
                          onClick={() =>
                            navigate({
                              sort: column.sort ?? undefined,
                              desc: active ? !desc : !ASCENDING_FIRST.has(column.sort as UserSort),
                            })
                          }
                        >
                          {label}
                          <span className={styles.arrow} aria-hidden="true">
                            {active ? (desc ? "↓" : "↑") : ""}
                          </span>
                        </button>
                      ) : (
                        label
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className={styles.row} onClick={() => router.push(paths.adminUser(row.id))}>
                  <td>
                    <Link href={paths.adminUser(row.id)} className={styles.userCell} onClick={(event) => event.stopPropagation()}>
                      <span className={styles.userName}>
                        {row.username ?? row.email ?? row.id}
                        {row.role && row.role !== "member" ? <span className={styles.badgeAccent}>{row.role}</span> : null}
                        {row.banned ? <span className={styles.badgeDanger}>{t.users.banned}</span> : null}
                        {!row.email_confirmed ? <span className={styles.badge}>{t.users.unconfirmed}</span> : null}
                      </span>
                      <span className={styles.userEmail}>{row.email}</span>
                    </Link>
                  </td>
                  <td>
                    <span className={row.plan && row.plan !== "free" ? styles.badgeAccent : styles.badge}>{row.plan ?? "free"}</span>
                  </td>
                  <td className={styles.num}>{row.hands > 0 ? fmt.number(row.hands) : <span className={styles.dim}>0</span>}</td>
                  <td className={styles.when}>{fmt.ago(row.last_hand_at) ?? <span className={styles.dim}>—</span>}</td>
                  <td className={styles.num}>{row.posts > 0 ? fmt.number(row.posts) : <span className={styles.dim}>0</span>}</td>
                  <td className={styles.num}>
                    {row.feedback > 0 ? (
                      <Link href={paths.adminReports(row.id)} onClick={(event) => event.stopPropagation()}>
                        {fmt.number(row.feedback)}
                      </Link>
                    ) : (
                      <span className={styles.dim}>0</span>
                    )}
                  </td>
                  <td className={styles.when}>{fmt.date(row.created_at)}</td>
                  <td className={styles.when}>{fmt.ago(row.last_sign_in_at) ?? <span className={styles.dim}>{t.users.never}</span>}</td>
                </tr>
              ))}
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
