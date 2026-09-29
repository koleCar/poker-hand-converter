import type { Metadata } from "next";
import Link from "next/link";
import { ServerFrame } from "../../components/shell/ServerFrame";
import { en } from "../../lib/i18n/en";
import { paths } from "../../lib/routes";
import styles from "../../components/forum/forum.module.css";

export const metadata: Metadata = {
  title: en.moderation.takedownTitle,
  alternates: { canonical: paths.takedown() },
};

/**
 * #31's promise, written down: a poker room or a player who wants a hand down
 * has a path that is not a lawyer, and a response time. The mechanism is the
 * `hh-takedown` report reason (`report_content`) and the mod queue.
 */
export default function TakedownPage() {
  return (
    <ServerFrame tab={null}>
      <section className="card stack">
        <h1 className={styles.postTitle}>{en.moderation.takedownHeading}</h1>
        {en.moderation.takedownBody.map((paragraph, index) => (
          <p key={index}>{paragraph}</p>
        ))}
        <div>
          <Link href={paths.home()} className="btn">
            {en.published.homeCta}
          </Link>
        </div>
      </section>
    </ServerFrame>
  );
}
