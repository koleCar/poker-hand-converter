"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { RailLoader } from "@rail/ui/loader/RailLoader";
import { adminUser, isAdminRefusal, type AdminUserDetail } from "../../lib/db/admin";
import { useDict } from "../../lib/i18n/client";
import { paths } from "../../lib/routes";
import { AdminError } from "./AdminShell";
import { KindBadge, StatusBadge } from "./badges";
import { isFuture, useAdminFormat } from "./format";
import styles from "./admin.module.css";

type Load =
  | { status: "loading" }
  | { status: "ready"; user: AdminUserDetail | null }
  | { status: "error"; denied: boolean; reason: string };

/**
 * One account: who it is, what it holds (hands by room and source, folders
 * and devices, the latest arrivals), what it wrote, its plan, and its reports.
 */
export function UserPage({ id }: { id: string }) {
  const t = useDict().admin;
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    adminUser(id)
      .then((user) => current && setLoad({ status: "ready", user }))
      .catch((error: unknown) => {
        if (!current) return;
        setLoad({ status: "error", denied: isAdminRefusal(error), reason: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      current = false;
    };
  }, [id, attempt]);

  return (
    <section className={styles.panel}>
      <Link href={paths.admin()} className={styles.back}>
        ← {t.user.back}
      </Link>
      {load.status === "loading" ? (
        <RailLoader label={t.loading} />
      ) : load.status === "error" ? (
        <AdminError denied={load.denied} reason={load.reason} onRetry={() => setAttempt((a) => a + 1)} />
      ) : load.user === null ? (
        <p className={styles.state}>{t.user.notFound}</p>
      ) : (
        <UserDetail user={load.user} />
      )}
    </section>
  );
}

function UserDetail({ user }: { user: AdminUserDetail }) {
  const t = useDict().admin;
  const u = t.user;
  const fmt = useAdminFormat();
  const p = user.profile;
  const none = <span className={styles.dim}>{u.none}</span>;
  const yesNo = (value: boolean) => (value ? u.yes : u.no);
  const banned = isFuture(p?.bannedUntil ?? null);
  const played =
    user.hands.firstPlayedAt && user.hands.lastPlayedAt
      ? `${fmt.date(user.hands.firstPlayedAt)} – ${fmt.date(user.hands.lastPlayedAt)}`
      : null;
  const siteMax = Math.max(1, ...user.hands.bySite.map((s) => s.hands));

  return (
    <>
      <header className={styles.userHead}>
        <span className={styles.avatar} aria-hidden="true">
          {(p?.username ?? user.email ?? "?").slice(0, 1).toUpperCase()}
        </span>
        <div className={styles.userTitle}>
          <h1>
            {p?.username ?? user.email}
            {p && p.role !== "member" ? <span className={styles.badgeAccent}>{p.role}</span> : null}
            <span className={p && p.plan !== "free" ? styles.badgeAccent : styles.badge}>{p?.plan ?? "free"}</span>
            {banned ? <span className={styles.badgeDanger}>{t.users.banned}</span> : null}
            {!user.emailConfirmedAt ? <span className={styles.badge}>{t.users.unconfirmed}</span> : null}
          </h1>
          <p>
            {user.email} · <CopyId id={user.id} />
          </p>
        </div>
      </header>

      <div className={styles.tiles}>
        <Tile label={u.stats.hands} value={fmt.number(user.hands.total)} sub={played} />
        <Tile label={u.stats.posts} value={fmt.number(user.content.posts)} />
        <Tile label={u.stats.comments} value={fmt.number(user.content.comments)} />
        <Tile label={u.stats.publishedHands} value={fmt.number(user.content.publishedHands)} />
        <Tile label={u.stats.shares} value={fmt.number(user.content.shares)} />
        <Tile label={u.stats.trainerAnswers} value={fmt.number(user.content.trainerAnswers)} />
        <Tile label={u.stats.feedback} value={fmt.number(user.feedback.length)} />
      </div>

      <div className={styles.columns}>
        <Card title={u.account}>
          <dl className={styles.fields}>
            <Field label={u.fields.email}>{user.email ?? none}</Field>
            <Field label={u.fields.emailConfirmed}>{fmt.dateTime(user.emailConfirmedAt) ?? u.no}</Field>
            <Field label={u.fields.created}>{fmt.dateTime(user.createdAt)}</Field>
            <Field label={u.fields.signedIn}>{fmt.dateTime(user.lastSignInAt) ?? t.users.never}</Field>
            <Field label={u.fields.providers}>{user.providers.length > 0 ? user.providers.join(", ") : none}</Field>
            {p ? (
              <>
                <Field label={u.fields.role}>{p.role}</Field>
                <Field label={u.fields.karma}>{fmt.number(p.karma)}</Field>
                <Field label={u.fields.earlyUser}>{yesNo(p.earlyUser)}</Field>
                <Field label={u.fields.digest}>{p.digest}</Field>
                {p.bannedUntil ? <Field label={u.fields.banned}>{fmt.dateTime(p.bannedUntil)}</Field> : null}
                {p.banReason ? <Field label={u.fields.banReason}>{p.banReason}</Field> : null}
                {p.shadowbanned ? <Field label={u.fields.shadowbanned}>{u.yes}</Field> : null}
              </>
            ) : null}
          </dl>
        </Card>

        <Card title={u.plan}>
          <dl className={styles.fields}>
            <Field label={u.planFields.plan}>{p?.plan ?? "free"}</Field>
            <Field label={u.planFields.status}>{p?.planStatus ?? none}</Field>
            <Field label={u.planFields.period}>{p?.planPeriod ?? none}</Field>
            <Field label={u.planFields.periodEnd}>{fmt.date(p?.currentPeriodEnd ?? null) ?? none}</Field>
            <Field label={u.planFields.stripe}>{yesNo(Boolean(p?.billingCustomer))}</Field>
          </dl>
        </Card>

        <Card title={u.bySite}>
          {user.hands.bySite.length === 0 ? (
            <p className={styles.dim}>{u.none}</p>
          ) : (
            <ul className={styles.bars}>
              {user.hands.bySite.map((site) => (
                <li key={site.site}>
                  <span className={styles.barLabel}>{site.site}</span>
                  <span className={styles.barTrack}>
                    <span className={styles.barFill} style={{ inlineSize: `${(site.hands / siteMax) * 100}%` }} />
                  </span>
                  <span className={styles.barValue}>{fmt.number(site.hands)}</span>
                </li>
              ))}
            </ul>
          )}
          {Object.keys(user.hands.byOrigin).length > 0 ? (
            <p className={styles.note}>
              {u.byOrigin}:{" "}
              {Object.entries(user.hands.byOrigin)
                .map(([origin, count]) => `${u.origins[origin] ?? origin} ${fmt.number(count)}`)
                .join(" · ")}
            </p>
          ) : null}
          <h3 className={styles.subhead}>{u.arrivals}</h3>
          {user.arrivals.length === 0 ? (
            <p className={styles.dim}>{u.noArrivals}</p>
          ) : (
            <ul className={styles.list}>
              {user.arrivals.map((arrival) => (
                <li key={arrival.at}>
                  <span>{u.arrivalHands(arrival.hands)}</span>
                  <span className={styles.dim}>{u.origins[arrival.origin] ?? arrival.origin}</span>
                  <span className={styles.when}>{fmt.ago(arrival.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

      </div>

      <Card title={u.sources}>
        {user.sources.length === 0 ? (
          <p className={styles.dim}>{u.noSources}</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>{u.sourceColumns.name}</th>
                  <th>{u.sourceColumns.device}</th>
                  <th>{u.sourceColumns.room}</th>
                  <th className={styles.num}>{u.sourceColumns.inserted}</th>
                  <th className={styles.num}>{u.sourceColumns.rejected}</th>
                  <th>{u.sourceColumns.last}</th>
                </tr>
              </thead>
              <tbody>
                {user.sources.map((source, index) => (
                  <tr key={`${source.createdAt}-${index}`}>
                    <td>{source.label ?? (source.kind === "web" ? u.origins.web : none)}</td>
                    <td>{source.device ?? none}</td>
                    <td>{source.site ?? none}</td>
                    <td className={styles.num}>{fmt.number(source.inserted)}</td>
                    <td className={styles.num}>{source.rejected > 0 ? fmt.number(source.rejected) : <span className={styles.dim}>0</span>}</td>
                    <td className={styles.when}>{fmt.ago(source.lastIngestAt) ?? none}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title={u.feedback}
        action={
          user.feedback.length > 0 ? (
            <Link href={paths.adminReports(user.id)} className={styles.cardLink}>
              {u.allFeedback} →
            </Link>
          ) : null
        }
      >
        {user.feedback.length === 0 ? (
          <p className={styles.dim}>{u.noFeedback}</p>
        ) : (
          <ul className={styles.list}>
            {user.feedback.map((report) => (
              <li key={report.id}>
                <KindBadge kind={report.kind} />
                <Link href={`${paths.adminReports(user.id)}#${report.id}`} className={styles.listMessage}>
                  {report.message}
                </Link>
                <StatusBadge status={report.status} />
                <span className={styles.when}>{fmt.ago(report.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string | null }) {
  return (
    <div className={styles.tile}>
      <span className={styles.tileLabel}>{label}</span>
      <span className={styles.tileValue}>{value}</span>
      {sub ? <span className={styles.tileSub}>{sub}</span> : null}
    </div>
  );
}

function Card({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className={styles.card}>
      <header className={styles.cardHead}>
        <h2>{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function CopyId({ id }: { id: string }) {
  const t = useDict().admin.user;
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={styles.copy}
      title={t.copyId}
      onClick={() => {
        void navigator.clipboard?.writeText(id).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      <code>{id}</code>
      <span className={styles.dim}>{copied ? t.copied : t.copyId}</span>
    </button>
  );
}
