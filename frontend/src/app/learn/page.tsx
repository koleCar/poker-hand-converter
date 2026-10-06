import type { Metadata } from "next";
import Link from "next/link";
import { CourseMap } from "../../components/learn/course/CourseMap";
import { LearnProvider } from "../../components/learn/course/LearnStore";
import { ServerFrame } from "../../components/shell/ServerFrame";
import { getDict, getLocale } from "../../lib/i18n/server";
import { LESSON_IDS } from "../../lib/learn/course";
import { lessonOutline } from "../../lib/learn/lessons";
import { paths } from "../../lib/routes";
import styles from "../../components/learn/course/course.module.css";

/**
 * The Learn tab (`docs/LEARN-PLAN.md`, L1): the course map.
 *
 * **Public and indexable**, like the concept library: the server renders the
 * catalogue and the outlines that ship with the app and reads no account. A
 * learner's progress, review cards and recommendations are read in the
 * browser (`LearnProvider`, `CourseMap`), from the account when signed in and
 * from the browser's storage otherwise.
 */

export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return {
    title: en.meta.course.title,
    description: en.meta.course.description,
    alternates: { canonical: paths.learn() },
    openGraph: { title: en.meta.course.title, description: en.meta.course.description, url: paths.learn() },
  };
}

export default async function LearnPage() {
  const [en, locale] = await Promise.all([getDict(), getLocale()]);
  const t = en.course;
  const summaries = Object.fromEntries(LESSON_IDS.map((id) => [id, lessonOutline(locale, id).summary]));
  return (
    <ServerFrame tab="learn">
      <LearnProvider>
        <div className={styles.page}>
          <header className={styles.pageHead}>
            <h1 className={styles.title}>{t.map.heading}</h1>
            <p className={styles.lead}>{t.map.intro}</p>
            <p className={styles.conceptsLink}>
              <Link href={paths.analysisLearn()} className="btn btn--sm btn--ghost">
                {t.map.concepts}
              </Link>
              <span className={styles.muted}>{t.map.conceptsHint}</span>
            </p>
          </header>
          <CourseMap summaries={summaries} />
        </div>
      </LearnProvider>
    </ServerFrame>
  );
}
