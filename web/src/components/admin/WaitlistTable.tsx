"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { RailLoader } from "@rail/ui/loader/RailLoader";
import { adminProWaitlist, isAdminRefusal, type AdminWaitlistRow } from "../../lib/db/admin";
import { useDict } from "../../lib/i18n/client";
import { paths } from "../../lib/routes";
import { AdminError } from "./AdminShell";
import { Pager } from "./Pager";
import { useAdminFormat } from "./format";
import styles from "./admin.module.css";

const PAGE = 100;

type Load =
  | { status: "loading" }
  | { status: "ready"; rows: AdminWaitlistRow[] }
  | { status: "error"; denied: boolean; reason: string };

/** The Pro waitlist: how many, and every address, newest first. */
export function WaitlistTable() {
  const t = useDict().admin;
  const w = t.waitlist;
  const fmt = useAdminFormat();
  const [page, setPage] = useState(0);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    adminProWaitlist({ limit: PAGE, offset: page * PAGE })
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
  }, [page, attempt]);

  if (load.status === "error") {
    return <AdminError denied={load.denied} reason={load.reason} onRetry={() => setAttempt((a) => a + 1)} />;
  }
  const rows = load.status === "ready" ? load.rows : [];
  const total = rows[0]?.total ?? 0;

  return (
    <section className={styles.panel}>
      <div className={styles.toolbar}>
        {load.status === "ready" ? <span className={styles.count}>{w.count(total)}</span> : null}
      </div>
      {load.status === "loading" ? (
        <RailLoader label={t.loading} />
      ) : rows.length === 0 ? (
        <p className={styles.state}>{w.empty}</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{w.columns.email}</th>
                <th>{w.columns.account}</th>
                <th>{w.columns.source}</th>
                <th>{w.columns.locale}</th>
                <th>{w.columns.when}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.email}</td>
                  <td>
                    {row.user_id ? (
                      <Link href={paths.adminUser(row.user_id)}>{row.username ?? row.user_id}</Link>
                    ) : (
                      <span className={styles.dim}>{w.visitor}</span>
                    )}
                  </td>
                  <td>{w.sources[row.source] ?? row.source}</td>
                  <td>{row.locale}</td>
                  <td className={styles.when}>{fmt.dateTime(row.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {load.status === "ready" && total > PAGE ? (
        <Pager offset={page * PAGE} size={rows.length} total={total} onPage={(delta) => setPage((p) => p + delta)} />
      ) : null}
    </section>
  );
}
