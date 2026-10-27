import type { Metadata } from "next";
import Link from "next/link";
import { LearnProvider } from "../../../components/learn/course/LearnStore";
import { PlacementTest } from "../../../components/learn/course/PlacementTest";
import { ServerFrame } from "../../../components/shell/ServerFrame";
import { getDict } from "../../../lib/i18n/server";
import { paths } from "../../../lib/routes";
import styles from "../../../components/learn/course/course.module.css";

/**
 * The placement test (Learn L5): a short mixed test per track, dealt from the
 * lessons' own exercises and graded by the same graders. A module passed
 * marks its lessons "tested out". It writes the learner's own progress, so
 * it is not indexed; it works signed out too, from the browser's storage.
 */

export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return {
    title: en.meta.learnPlacement.title,
    description: en.meta.learnPlacement.description,
    robots: { index: false, follow: true },
  };
}

export default async function LearnPlacementPage() {
  const en = await getDict();
  const t = en.course;
  return (
    <ServerFrame tab="learn">
      <LearnProvider>
        <div className={styles.page}>
          <header className={styles.pageHead}>
            <p className={styles.eyebrow}>
              <Link href={paths.learn()}>{t.lesson.breadcrumb}</Link>
            </p>
            <h1 className={styles.title}>{t.placement.heading}</h1>
            <p className={styles.lead}>{t.placement.intro}</p>
          </header>
          <PlacementTest />
        </div>
      </LearnProvider>
    </ServerFrame>
  );
}
