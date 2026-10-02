"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AppFrame } from "../../components/shell/AppFrame";
import { formatPostDate } from "../../components/forum/format";
import { useAuth } from "../../lib/auth";
import { forumErrorMessage } from "../../lib/db/forum";
import {
  banUser,
  createBoard,
  modQueue,
  modUser,
  resolveReport,
  setBoardModerator,
  setCommentStatus,
  setPostStatus,
  setPublishedHandStatus,
  setRole,
  shadowbanUser,
  spamQueue,
  unbanUser,
  voteOverlap,
  type ModUser,
  type QueueItem,
  type SpamItem,
} from "../../lib/db/moderation";
import { useDict } from "../../lib/i18n/client";
import { useMyProfile } from "../../lib/profile/context";
import { paths } from "../../lib/routes";
import styles from "../../components/forum/forum.module.css";

type Tab = "reports" | "spam" | "users" | "admin";

export function ModScreen() {
  return <AppFrame tab={null}>{() => <ModBody />}</AppFrame>;
}

function ModBody() {
  const en = useDict();
  const auth = useAuth();
  const { profile } = useMyProfile();
  const [tab, setTab] = useState<Tab>("reports");
  const [denied, setDenied] = useState(false);

  if (!auth.isSignedIn) {
    return (
      <section className="card stack">
        <h1 className={styles.postTitle}>{en.moderation.modHeading}</h1>
        <p className="muted">{en.moderation.notModerator}</p>
      </section>
    );
  }

  const tabs: Tab[] = ["reports", "spam", "users", ...(profile?.role === "admin" ? (["admin"] as Tab[]) : [])];

  return (
    <section className="stack">
      <h1 className={styles.postTitle}>{en.moderation.modHeading}</h1>
      {denied ? <p className="notice notice--warn">{en.moderation.notModerator}</p> : null}
      <nav className={styles.chips}>
        {tabs.map((value) => (
          <button
            key={value}
            type="button"
            className={styles.chipLink}
            aria-current={tab === value ? "page" : undefined}
            onClick={() => setTab(value)}
          >
            {en.moderation.tabs[value]}
          </button>
        ))}
      </nav>
      {tab === "reports" ? <Reports onDenied={() => setDenied(true)} /> : null}
      {tab === "spam" ? <Spam onDenied={() => setDenied(true)} /> : null}
      {tab === "users" ? <Users /> : null}
      {tab === "admin" ? <Admin /> : null}
    </section>
  );
}

function subjectHref(item: QueueItem): string | null {
  const s = item.subject;
  if (!s) return null;
  if (item.subjectType === "post" && s.board && s.publicId && s.slug) return paths.post(s.board, s.publicId, s.slug);
  if (item.subjectType === "comment" && s.board && s.publicId && s.slug && s.seq) return paths.comment(s.board, s.publicId, s.slug, s.seq);
  if (item.subjectType === "published_hand" && s.publicId) return paths.publishedHand(s.publicId);
  if (item.subjectType === "profile" && s.username) return paths.profile(s.username);
  return null;
}

function Reports({ onDenied }: { onDenied: () => void }) {
  const en = useDict();
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    () =>
      modQueue().then(setItems, (err) => {
        setItems([]);
        onDenied();
        setError(forumErrorMessage(err));
      }),
    [onDenied],
  );
  useEffect(() => {
    void load();
  }, [load]);

  async function act(item: QueueItem, remove: boolean, status: "actioned" | "dismissed") {
    setError(null);
    try {
      const s = item.subject;
      if (remove && s?.publicId) {
        if (item.subjectType === "post") await setPostStatus(s.publicId, "removed", item.reason);
        if (item.subjectType === "comment" && s.seq) await setCommentStatus(s.publicId, s.seq, "removed", item.reason);
        if (item.subjectType === "published_hand") await setPublishedHandStatus(s.publicId, "removed", item.reason);
      }
      await resolveReport(item.id, status);
      await load();
    } catch (err) {
      setError(forumErrorMessage(err));
    }
  }

  if (items === null) return null;
  return (
    <div className="stack">
      {error ? <p className="notice notice--error">{error}</p> : null}
      {items.length === 0 ? <p className="muted">{en.moderation.noReports}</p> : null}
      <ol className={styles.hits}>
        {items.map((item) => {
          const href = subjectHref(item);
          return (
            <li key={item.id} className={styles.card}>
              <div className={styles.cardBody}>
                <p className={styles.cardTitle}>
                  {en.moderation.reasons[item.reason]} — {item.subjectType}
                </p>
                <p className={styles.meta}>
                  {item.reporter ? <span>{en.moderation.reportedBy(item.reporter)}</span> : null}
                  <span aria-hidden="true">·</span>
                  <time dateTime={item.createdAt}>{formatPostDate(item.createdAt, en.chrome.intl)}</time>
                  {item.subject?.author ? (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>{item.subject.author}</span>
                    </>
                  ) : null}
                </p>
                {item.subject?.title ? <p>{item.subject.title}</p> : null}
                {item.subject?.excerpt ? <p className="muted">{item.subject.excerpt}</p> : null}
                {item.details ? <p className="notice notice--info">{item.details}</p> : null}
                <div className={styles.row}>
                  {href ? (
                    <Link href={href} className="btn btn--sm">
                      {en.moderation.open}
                    </Link>
                  ) : null}
                  {item.subjectType !== "profile" ? (
                    <button type="button" className="btn btn--sm btn--primary" onClick={() => void act(item, true, "actioned")}>
                      {en.moderation.remove}
                    </button>
                  ) : null}
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => void act(item, false, "dismissed")}>
                    {en.moderation.dismiss}
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Spam({ onDenied }: { onDenied: () => void }) {
  const en = useDict();
  const [items, setItems] = useState<SpamItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    () =>
      spamQueue().then(setItems, (err) => {
        setItems([]);
        onDenied();
        setError(forumErrorMessage(err));
      }),
    [onDenied],
  );
  useEffect(() => {
    void load();
  }, [load]);

  async function decide(item: SpamItem, status: "visible" | "removed") {
    setError(null);
    try {
      if (item.type === "post") await setPostStatus(item.publicId, status, "spam queue");
      else if (item.seq) await setCommentStatus(item.publicId, item.seq, status, "spam queue");
      await load();
    } catch (err) {
      setError(forumErrorMessage(err));
    }
  }

  if (items === null) return null;
  return (
    <div className="stack">
      {error ? <p className="notice notice--error">{error}</p> : null}
      {items.length === 0 ? <p className="muted">{en.moderation.noSpam}</p> : null}
      <ol className={styles.hits}>
        {items.map((item) => (
          <li key={`${item.type}-${item.publicId}-${item.seq ?? 0}`} className={styles.card}>
            <div className={styles.cardBody}>
              <p className={styles.cardTitle}>{item.title}</p>
              <p className={styles.meta}>
                <span>{item.type}</span>
                <span aria-hidden="true">·</span>
                <span>{item.author}</span>
                <span aria-hidden="true">·</span>
                <time dateTime={item.createdAt}>{formatPostDate(item.createdAt, en.chrome.intl)}</time>
              </p>
              {item.excerpt ? <p className="muted">{item.excerpt}</p> : null}
              <div className={styles.row}>
                <button type="button" className="btn btn--sm btn--primary" onClick={() => void decide(item, "visible")}>
                  {en.moderation.approve}
                </button>
                <button type="button" className="btn btn--sm" onClick={() => void decide(item, "removed")}>
                  {en.moderation.remove}
                </button>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Users() {
  const en = useDict();
  const [name, setName] = useState("");
  const [user, setUser] = useState<ModUser | null>(null);
  const [overlap, setOverlap] = useState<Array<{ with: string; sharedVotes: number; sameDirection: number }>>([]);
  const [days, setDays] = useState("7");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function lookup(event?: FormEvent) {
    event?.preventDefault();
    setError(null);
    setMessage(null);
    try {
      setUser(await modUser(name));
      setOverlap(await voteOverlap(name));
    } catch (err) {
      setError(forumErrorMessage(err));
    }
  }

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      setMessage(en.moderation.done);
      await lookup();
    } catch (err) {
      setError(forumErrorMessage(err));
    }
  }

  return (
    <div className="stack">
      <form className={styles.searchForm} onSubmit={(event) => void lookup(event)}>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder={en.moderation.usernamePlaceholder} />
        <button type="submit" className="btn btn--sm">
          {en.moderation.lookup}
        </button>
      </form>
      {error ? <p className="notice notice--error">{error}</p> : null}
      {message ? <p className="notice notice--info">{message}</p> : null}
      {user ? (
        <div className="card stack">
          <p className={styles.cardTitle}>
            <Link href={paths.profile(user.username)}>{user.username}</Link>
            {en.moderation.userLine(en.moderation.roles[user.role], user.karma)}
          </p>
          <p className={styles.meta}>
            <span>{en.moderation.facts.joined(user.joinedOn)}</span>
            <span>{en.moderation.facts.posts(user.posts)}</span>
            <span>{en.moderation.facts.comments(user.comments)}</span>
            <span>{en.moderation.facts.reports(user.reportsAgainst)}</span>
            {user.bannedUntil ? <span>{en.moderation.facts.bannedUntil(user.bannedUntil)}</span> : null}
            {user.isShadowbanned ? <span>{en.moderation.facts.shadowbanned}</span> : null}
          </p>
          <div className={styles.composer}>
            <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder={en.moderation.reasonPrompt} />
            <label className={styles.row}>
              <span className="muted">{en.moderation.banDays}</span>
              <input value={days} onChange={(event) => setDays(event.target.value)} inputMode="numeric" style={{ maxInlineSize: 80 }} />
            </label>
            <div className={styles.row}>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void run(() => banUser(user.username, days.trim() ? Number(days) : null, reason))}
              >
                {en.moderation.ban}
              </button>
              {user.bannedUntil ? (
                <button type="button" className="btn btn--sm" onClick={() => void run(() => unbanUser(user.username, reason))}>
                  {en.moderation.unban}
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                onClick={() => void run(() => shadowbanUser(user.username, !user.isShadowbanned, reason))}
              >
                {user.isShadowbanned ? en.moderation.unshadowban : en.moderation.shadowban}
              </button>
            </div>
          </div>
          <div className="stack">
            <strong>{en.moderation.overlap}</strong>
            {overlap.length === 0 ? <p className="muted">{en.moderation.noOverlap}</p> : null}
            {overlap.map((row) => (
              <p key={row.with} className={styles.meta}>
                {row.with} — {row.sameDirection}/{row.sharedVotes}
              </p>
            ))}
          </div>
          <ol className={styles.thread}>
            {user.history.map((entry, index) => (
              <li key={index} className={styles.meta}>
                {entry.action} · {entry.reason ?? ""} · {formatPostDate(entry.createdAt, en.chrome.intl)}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}

function Admin() {
  const en = useDict();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [roleUser, setRoleUser] = useState("");
  const [role, setRoleValue] = useState<"member" | "moderator" | "admin">("moderator");
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [boardMod, setBoardMod] = useState({ board: "", user: "" });

  async function run(action: () => Promise<unknown>) {
    setError(null);
    setMessage(null);
    try {
      await action();
      setMessage(en.moderation.done);
    } catch (err) {
      setError(forumErrorMessage(err));
    }
  }

  return (
    <div className="stack">
      {error ? <p className="notice notice--error">{error}</p> : null}
      {message ? <p className="notice notice--info">{message}</p> : null}
      <div className={`card ${styles.composer}`}>
        <strong>{en.moderation.setRole}</strong>
        <div className={styles.row}>
          <input value={roleUser} onChange={(event) => setRoleUser(event.target.value)} placeholder={en.moderation.usernamePlaceholder} />
          <select value={role} onChange={(event) => setRoleValue(event.target.value as typeof role)}>
            {(["member", "moderator", "admin"] as const).map((value) => (
              <option key={value} value={value}>
                {en.moderation.roles[value]}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn--sm" onClick={() => void run(() => setRole(roleUser, role))}>
            {en.moderation.setRole}
          </button>
        </div>
      </div>
      <div className={`card ${styles.composer}`}>
        <strong>{en.moderation.createBoard}</strong>
        <div className={styles.row}>
          <input value={slug} onChange={(event) => setSlug(event.target.value)} placeholder={en.moderation.boardSlug} />
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder={en.moderation.boardName} />
          <button type="button" className="btn btn--sm" onClick={() => void run(() => createBoard(slug, name))}>
            {en.moderation.createBoard}
          </button>
        </div>
      </div>
      <div className={`card ${styles.composer}`}>
        <strong>{en.moderation.boardMod}</strong>
        <div className={styles.row}>
          <input value={boardMod.board} onChange={(event) => setBoardMod({ ...boardMod, board: event.target.value })} placeholder={en.moderation.boardSlug} />
          <input value={boardMod.user} onChange={(event) => setBoardMod({ ...boardMod, user: event.target.value })} placeholder={en.moderation.usernamePlaceholder} />
          <button type="button" className="btn btn--sm" onClick={() => void run(() => setBoardModerator(boardMod.board, boardMod.user, true))}>
            {en.moderation.grant}
          </button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => void run(() => setBoardModerator(boardMod.board, boardMod.user, false))}>
            {en.moderation.revoke}
          </button>
        </div>
      </div>
    </div>
  );
}
