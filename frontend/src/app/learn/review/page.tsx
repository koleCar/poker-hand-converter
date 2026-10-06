import type { Metadata } from "next";
import Link from "next/link";
import { LearnProvider } from "../../../components/learn/course/LearnStore";
import { ReviewQueue } from "../../../components/learn/course/ReviewQueue";
import { ServerFrame } from "../../../components/shell/ServerFrame";
import { getDict } from "../../../lib/i18n/server";
import { paths } from "../../../lib/routes";
import styles from "../../../components/learn/course/course.module.css";

/**
 * The review queue (Learn L1): the learner's missed quiz items, due again.
 * Personal, so not indexed; it works signed out too, from the browser's
 * storage.
 */

export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return {
    title: en.meta.learnReview.title,
    description: en.meta.learnReview.description,
    robots: { index: false, follow: true },
  };
}

export default async function LearnReviewPage() {
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
            <h1 className={styles.title}>{t.review.heading}</h1>
            <p className={styles.lead}>{t.review.intro}</p>
          </header>
          <ReviewQueue />
        </div>
      </LearnProvider>
    </ServerFrame>
  );
}
