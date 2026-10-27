import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { ExerciseBlock } from "../../../components/learn/course/ExerciseBlock";
import { LearnProvider } from "../../../components/learn/course/LearnStore";
import { Block } from "../../../components/learn/course/LessonBlocks";
import { LessonExamples } from "../../../components/learn/course/LessonExamples";
import { LessonMastery } from "../../../components/learn/course/LessonMastery";
import { ModuleCapstone } from "../../../components/learn/course/ModuleCapstone";
import { LessonStatusChip, MasteredBanner, StorageNote } from "../../../components/learn/course/LessonStatus";
import { PoolTendencies } from "../../../components/learn/course/PoolTendencies";
import { RichText } from "../../../components/learn/course/RichText";
import { ServerFrame } from "../../../components/shell/ServerFrame";
import { getDict, getLocale } from "../../../lib/i18n/server";
import { LESSONS, MOVED_LESSONS, isLessonId, isReferenceId, moduleCode, neighbours, type LessonMeta } from "../../../lib/learn/course";
import { lessonBody, lessonOutline } from "../../../lib/learn/lessons";
import { capstoneLesson } from "../../../lib/learn/mixed";
import { paths } from "../../../lib/routes";
import styles from "../../../components/learn/course/course.module.css";

/**
 * One lesson (Learn L1): its goals, the sections that teach the idea (text
 * rendered here; the concept widgets and the "predict, then reveal"
 * checkpoints are client islands fed this lesson's words), rules of thumb,
 * and the practice — exercises generated and graded by Rail's engine, passed
 * automatically. A lesson not written yet shows its outline as "coming soon".
 *
 * Public and indexable like the course map: nothing on the server reads an
 * account; progress and "your hands" are the learner's, read in the browser.
 *
 * Old addresses keep working (L1.1): an L1 orientation, maths or range lesson
 * is a reference page now and redirects there, and a split lesson redirects
 * to its first half (`MOVED_LESSONS`).
 */

interface PageProps {
  params: Promise<{ lesson: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { lesson } = await params;
  const [en, locale] = await Promise.all([getDict(), getLocale()]);
  if (!isLessonId(lesson)) {
    return { title: en.meta.notFound.title, description: en.meta.notFound.description };
  }
  const title = en.meta.lesson(en.course.titles[lesson]);
  const description = lessonOutline(locale, lesson).summary;
  return {
    title,
    description,
    alternates: { canonical: paths.lesson(lesson) },
    openGraph: { title, description, url: paths.lesson(lesson), type: "article" },
  };
}

/** Where an address that is not a lesson (any more) lives now, or null. */
function movedTo(segment: string): string | null {
  if (isReferenceId(segment)) return paths.learnReference(segment);
  const moved = MOVED_LESSONS[segment];
  return moved ? paths.lesson(moved) : null;
}

export default async function LessonPage({ params }: PageProps) {
  const { lesson } = await params;
  if (!isLessonId(lesson)) {
    const to = movedTo(lesson);
    if (to) permanentRedirect(to);
    notFound();
  }
  const [en, locale] = await Promise.all([getDict(), getLocale()]);
  const t = en.course;
  const meta: LessonMeta = LESSONS[lesson];
  const outline = lessonOutline(locale, lesson);
  const body = meta.written ? lessonBody(locale, lesson) : null;
  const { previous, next } = neighbours(lesson);
  const id = (section: string) => `${lesson}-${section}`;

  return (
    <ServerFrame tab="learn">
      <LearnProvider>
        <article className={styles.page}>
          <header className={styles.pageHead}>
            <p className={styles.eyebrow}>
              <Link href={paths.learn()}>{t.lesson.breadcrumb}</Link>
              <span aria-hidden="true"> / </span>
              <span>
                {t.moduleCode(moduleCode(meta.module))} · {t.modules[meta.module]}
              </span>
            </p>
            <p className={styles.lessonMeta}>
              <span className={styles.lessonCode}>{meta.code}</span>
              {body ? <LessonStatusChip lesson={lesson} /> : <span className={styles.tag}>{t.map.comingSoon}</span>}
            </p>
            <h1 className={styles.title}>{t.titles[lesson]}</h1>
            <p className={styles.lead}>{outline.summary}</p>
            {body ? <StorageNote /> : null}
          </header>

          {(meta.notes ?? []).map((note) => (
            <p key={note} className={styles.banner} data-tone={note === "approximate-ranges" ? "approximate" : "conceptual"}>
              {t.notes[note]}
            </p>
          ))}

          <section className={styles.section} aria-labelledby={id("goals")}>
            <h2 id={id("goals")}>{t.lesson.goals}</h2>
            <ul className={styles.list}>
              {outline.goals.map((goal) => (
                <li key={goal}>
                  <RichText text={goal} />
                </li>
              ))}
            </ul>
            {meta.prereqs.length > 0 ? (
              <p className={styles.related}>
                <span className={styles.muted}>{t.lesson.prereqs}: </span>
                {meta.prereqs.map((prereq, index) => (
                  <span key={prereq}>
                    {index > 0 ? ", " : null}
                    <Link href={paths.lesson(prereq)}>{t.titles[prereq]}</Link>
                  </span>
                ))}
                <span className={styles.muted}> · {t.lesson.prereqsNote}</span>
              </p>
            ) : null}
            <p className={styles.related}>
              <span className={styles.muted}>{t.lesson.concepts}: </span>
              {meta.concepts.map((concept, index) => (
                <span key={concept}>
                  {index > 0 ? ", " : null}
                  <Link href={paths.analysisConcept(concept)}>{en.learn.titles[concept]}</Link>
                </span>
              ))}
            </p>
          </section>

          {body ? (
            <>
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

              {meta.examples?.length ? (
                <section className={styles.section} aria-labelledby={id("examples")}>
                  <h2 id={id("examples")}>{t.examples.heading}</h2>
                  <LessonExamples meta={meta} />
                </section>
              ) : null}

              {meta.pool ? (
                <section className={styles.section} aria-labelledby={id("pool")}>
                  <h2 id={id("pool")}>{t.pool.title}</h2>
                  <PoolTendencies topic={meta.pool} />
                </section>
              ) : null}

              <section className={styles.section} aria-labelledby={id("practice")}>
                <h2 id={id("practice")}>{t.lesson.practice}</h2>
                <p className={styles.muted}>{t.lesson.practiceIntro}</p>
                <MasteredBanner lesson={lesson} />
                <LessonMastery lesson={lesson} />
                {meta.exercises.map((def, i) => (
                  <ExerciseBlock key={def.id} meta={meta} def={def} index={i + 1} intro={body.exercises[def.id] ?? ""} />
                ))}
              </section>

              {capstoneLesson(meta.module) === lesson ? <ModuleCapstone module={meta.module} /> : null}
            </>
          ) : (
            <section className={styles.section} aria-labelledby={id("soon")}>
              <h2 id={id("soon")}>{t.lesson.comingSoonTitle}</h2>
              <p>{t.lesson.comingSoonBody}</p>
              <p className={styles.muted}>{t.lesson.comingSoonPractice}</p>
              <ul className={styles.list}>
                {meta.exercises.map((def) => (
                  <li key={def.id}>{t.exerciseKinds[def.kind]}</li>
                ))}
              </ul>
            </section>
          )}

          <nav className={styles.pager} aria-label={t.lesson.back}>
            {previous ? (
              <Link href={paths.lesson(previous.id)} className="btn btn--sm btn--ghost">
                ← {t.titles[previous.id]}
              </Link>
            ) : (
              <span />
            )}
            <Link href={paths.learn()} className="btn btn--sm">
              {t.lesson.back}
            </Link>
            {next ? (
              <Link href={paths.lesson(next.id)} className="btn btn--sm btn--ghost">
                {t.titles[next.id]} →
              </Link>
            ) : (
              <span />
            )}
          </nav>
        </article>
      </LearnProvider>
    </ServerFrame>
  );
}
