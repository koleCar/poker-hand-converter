"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatPostDate } from "../../components/forum/format";
import { AppFrame } from "../../components/shell/AppFrame";
import { useAuth } from "../../lib/auth";
import { markNotificationsRead, myNotifications, type NotificationItem } from "../../lib/db/social";
import { useDict } from "../../lib/i18n/client";
import { paths } from "../../lib/routes";
import styles from "../../components/forum/forum.module.css";

/** Client half of `/notifications`: one account's own rows, read through RLS. */
export function NotificationsScreen() {
  return <AppFrame tab={null}>{() => <NotificationsList />}</AppFrame>;
}

function NotificationsList() {
  const en = useDict();
  const auth = useAuth();
  const [items, setItems] = useState<NotificationItem[] | null>(null);

  useEffect(() => {
    if (!auth.isSignedIn) return;
    let active = true;
    myNotifications().then(
      (result) => {
        if (active) setItems(result.items);
      },
      () => {
        if (active) setItems([]);
      },
    );
    return () => {
      active = false;
    };
  }, [auth.isSignedIn]);

  if (!auth.isSignedIn) {
    return (
      <section className="card stack">
        <h1 className={styles.postTitle}>{en.social.notificationsHeading}</h1>
        <div>
          <button type="button" className="btn btn--primary" onClick={() => auth.requestSignIn(en.social.signIn)}>
            {en.social.signIn}
          </button>
        </div>
      </section>
    );
  }

  async function markAll() {
    await markNotificationsRead();
    setItems((current) => current?.map((item) => ({ ...item, read: true })) ?? null);
    window.dispatchEvent(new Event("rail:notifications-read"));
  }

  return (
    <section className="stack">
      <div className={styles.toolbar}>
        <h1 className={styles.postTitle}>{en.social.notificationsHeading}</h1>
        {items?.some((item) => !item.read) ? (
          <button type="button" className="btn btn--sm" onClick={() => void markAll()}>
            {en.social.markAllRead}
          </button>
        ) : null}
      </div>
      {items === null ? null : items.length === 0 ? (
        <p className="muted">{en.social.noNotifications}</p>
      ) : (
        <ol className={styles.hits}>
          {items.map((item) => {
            const actor = item.actor?.username ?? en.social.someone;
            const href = item.seq
              ? paths.comment(item.post.board, item.post.publicId, item.post.slug, item.seq)
              : paths.post(item.post.board, item.post.publicId, item.post.slug);
            return (
              <li key={item.id} className={styles.card} style={item.read ? undefined : { borderColor: "var(--accent)" }}>
                <div className={styles.cardBody}>
                  <p className={styles.cardTitle}>
                    <Link
                      href={href}
                      onClick={() => {
                        if (!item.read) {
                          void markNotificationsRead([item.id]).then(() =>
                            window.dispatchEvent(new Event("rail:notifications-read")),
                          );
                        }
                      }}
                    >
                      {en.social.kinds[item.kind](actor)}
                    </Link>
                  </p>
                  <p className={styles.meta}>
                    <span>{item.post.title}</span>
                    <span aria-hidden="true">·</span>
                    <time dateTime={item.createdAt}>{formatPostDate(item.createdAt)}</time>
                  </p>
                  {item.excerpt ? <p className="muted">{item.excerpt}</p> : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
