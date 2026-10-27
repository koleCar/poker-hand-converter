import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Block } from "../../../../components/learn/course/LessonBlocks";
import { RichText } from "../../../../components/learn/course/RichText";
import { ServerFrame } from "../../../../components/shell/ServerFrame";
import { getDict, getLocale } from "../../../../lib/i18n/server";
import { REFERENCE_CONCEPTS, isReferenceId } from "../../../../lib/learn/course";
import { lessonOutline, referenceBody } from "../../../../lib/learn/lessons";
import { paths } from "../../../../lib/routes";
import styles from "../../../../components/learn/course/course.module.css";

/**
 * One reference page (Learn L1.1): an idea the course assumes — L1's
 * orientation, maths and range lessons, out of the course map since the
 * restructure (no basics in the course, `docs/LEARN-PLAN.md` principle 8).
 * The text, widgets and checkpoints are kept as they were; there is no
 * practice and no progress. Lessons link here the first time they use the
 * term, and the map's intro panel lists every page.
 *
 * Public and indexable, like the lessons; nothing here reads an account.
 */

interface PageProps {
  params: Promise<{ page: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { page } = await params;
  const [en, locale] = await Promise.all([getDict(), getLocale()]);
  if (!isReferenceId(page)) {
    return { title: en.meta.notFound.title, description: en.meta.notFound.description };
  }
  const title = en.meta.lesson(en.course.titles[page]);
  const description = lessonOutline(locale, page).summary;
  return {
    title,
    description,
    alternates: { canonical: paths.learnReference(page) },
    openGraph: { title, description, url: paths.learnReference(page), type: "article" },
  };
}

export default async function ReferencePage({ params }: PageProps) {
  const { page } = await params;
  if (!isReferenceId(page)) notFound();
  const [en, locale] = await Promise.all([getDict(), getLocale()]);
  const t = en.course;
  const outline = lessonOutline(locale, page);
  const body = referenceBody(locale, page);
  const id = (section: string) => `${page}-${section}`;

  return (
    <ServerFrame tab="learn">
      <article className={styles.page}>
        <header className={styles.pageHead}>
          <p className={styles.eyebrow}>
            <Link href={paths.learn()}>{t.lesson.breadcrumb}</Link>
            <span aria-hidden="true"> / </span>
            <span>{t.lesson.referenceEyebrow}</span>
          </p>
          <h1 className={styles.title}>{t.titles[page]}</h1>
          <p className={styles.lead}>{outline.summary}</p>
          <p className={styles.muted}>{t.lesson.referenceNote}</p>
        </header>

        <section className={styles.section} aria-labelledby={id("goals")}>
          <h2 id={id("goals")}>{t.lesson.referenceGoals}</h2>
          <ul className={styles.list}>
            {outline.goals.map((goal) => (
              <li key={goal}>
                <RichText text={goal} />
              </li>
            ))}
          </ul>
          <p className={styles.related}>
            <span className={styles.muted}>{t.lesson.concepts}: </span>
            {REFERENCE_CONCEPTS[page].map((concept, index) => (
              <span key={concept}>
                {index > 0 ? ", " : null}
                <Link href={paths.analysisConcept(concept)}>{en.learn.titles[concept]}</Link>
              </span>
            ))}
          </p>
        </section>

        {body.sections.map((section, index) => (
          <section key={section.heading} className={styles.section} aria-labelledby={id(`s${index}`)}>
            <h2 id={id(`s${index}`)}>{section.heading}</h2>
            {section.blocks.map((block, k) => (
              <Block key={k} block={block} whereLabel={en.learn.page.where} />
            ))}
          </section>
        ))}

        <section className={styles.section} aria-labelledby={id("rules")}>
          <h2 id={id("rules")}>{t.lesson.heuristics}</h2>
          <ul className={styles.list}>
            {body.heuristics.rules.map((rule) => (
              <li key={rule}>
                <RichText text={rule} />
              </li>
            ))}
          </ul>
          <h3>{t.lesson.breaks}</h3>
          <ul className={styles.list}>
            {body.heuristics.breaks.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>

        <nav className={styles.pager} aria-label={t.lesson.back}>
          <span />
          <Link href={paths.learn()} className="btn btn--sm">
            {t.lesson.back}
          </Link>
          <span />
        </nav>
      </article>
    </ServerFrame>
  );
}
