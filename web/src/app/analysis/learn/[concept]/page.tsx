import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AnalysisNav } from "../../../../components/analysis/AnalysisNav";
import { ConceptWidget } from "../../../../components/learn/ConceptWidget";
import { Formula } from "../../../../components/learn/Formula";
import { SizingTable } from "../../../../components/learn/SizingTable";
import { ServerFrame } from "../../../../components/shell/ServerFrame";
import { INTL_LOCALE } from "../../../../lib/i18n/dictionaries";
import { getDict, getLocale } from "../../../../lib/i18n/server";
import { CONCEPTS, isConceptId } from "../../../../lib/learn/concepts";
import { conceptText } from "../../../../lib/learn/content";
import { paths } from "../../../../lib/routes";
import styles from "../../../../components/learn/learn.module.css";

/**
 * One concept page: definition, why it matters, the maths, a worked example,
 * an interactive example, common mistakes, related concepts — and, for the
 * concepts a heuristic flag explains, a link to the reader's own flagged hands.
 *
 * Text renders on the server, in the reader's language; the interactive
 * example is the one client component. Public and indexable like the index
 * (see `../page.tsx`). The "your hands" link is a plain link to `/analysis`
 * with a flag filter: the page itself never reads anyone's hands, so nothing
 * on it differs between readers.
 */

interface PageProps {
  params: Promise<{ concept: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { concept } = await params;
  const [en, locale] = await Promise.all([getDict(), getLocale()]);
  if (!isConceptId(concept)) {
    return { title: en.meta.notFound.title, description: en.meta.notFound.description };
  }
  const title = en.meta.learnConcept(en.learn.titles[concept]);
  const description = conceptText(locale, concept).summary;
  return {
    title,
    description,
    alternates: { canonical: paths.analysisConcept(concept) },
    openGraph: { title, description, url: paths.analysisConcept(concept), type: "article" },
  };
}

export default async function ConceptPage({ params }: PageProps) {
  const { concept } = await params;
  if (!isConceptId(concept)) {
    notFound();
  }
  const [en, locale] = await Promise.all([getDict(), getLocale()]);
  const t = en.learn;
  const meta = CONCEPTS[concept];
  const text = conceptText(locale, concept);
  const id = (section: string) => `${concept}-${section}`;

  return (
    <ServerFrame tab="analysis">
      <article className={styles.page}>
        <header className={styles.pageHead}>
          <AnalysisNav current="learn" />
          <p className={styles.eyebrow}>
            <Link href={paths.analysisLearn()}>{t.page.breadcrumb}</Link>
            <span aria-hidden="true"> / </span>
            <span>{t.index.groups[meta.group]}</span>
          </p>
          <h1 className={styles.title}>{t.titles[concept]}</h1>
          <p className={styles.lead}>{text.summary}</p>
        </header>

        <section className={styles.section} aria-labelledby={id("definition")}>
          <h2 id={id("definition")}>{t.page.definition}</h2>
          {text.definition.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </section>

        <section className={styles.section} aria-labelledby={id("why")}>
          <h2 id={id("why")}>{t.page.why}</h2>
          {text.why.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </section>

        {text.formulas && text.formulas.length > 0 ? (
          <section className={styles.section} aria-labelledby={id("maths")}>
            <h2 id={id("maths")}>{t.page.formulas}</h2>
            {text.formulas.map((formula) => (
              <Formula key={formula.name} formula={formula} whereLabel={t.page.where} />
            ))}
            {meta.sizingTable ? <SizingTable t={t.widgets.sizingTable} intl={INTL_LOCALE[locale]} /> : null}
          </section>
        ) : null}

        <section className={styles.section} aria-labelledby={id("example")}>
          <h2 id={id("example")}>{t.page.example}</h2>
          <div className={styles.example}>
            <h3>{text.example.title}</h3>
            <p>{text.example.setup}</p>
            <ol>
              {text.example.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <p className={styles.takeaway}>{text.example.takeaway}</p>
          </div>
        </section>

        {meta.widget ? (
          <section className={styles.section} aria-labelledby={id("try")}>
            <h2 id={id("try")}>{t.page.tryIt}</h2>
            {text.tryIt ? <p className={styles.hintLead}>{text.tryIt}</p> : null}
            <div className={styles.widget}>
              <ConceptWidget preset={meta.widget} />
            </div>
          </section>
        ) : null}

        <section className={styles.section} aria-labelledby={id("mistakes")}>
          <h2 id={id("mistakes")}>{t.page.mistakes}</h2>
          <ul className={styles.mistakes}>
            {text.mistakes.map((mistake) => (
              <li key={mistake}>{mistake}</li>
            ))}
          </ul>
        </section>

        {meta.flags.length > 0 ? (
          <section className={styles.section} aria-labelledby={id("hands")}>
            <h2 id={id("hands")}>{t.page.yourHands}</h2>
            <p>{t.page.yourHandsBody}</p>
            <ul className={styles.handLinks}>
              {meta.flags.map((flag) => (
                <li key={flag}>
                  <Link href={paths.analysis(new URLSearchParams({ flag }).toString())}>
                    {t.page.handsWithFlag(en.analysis.flags[flag] ?? flag)}
                  </Link>
                </li>
              ))}
            </ul>
            <p className={styles.hint}>{t.page.yourHandsNote}</p>
          </section>
        ) : null}

        <section className={styles.section} aria-labelledby={id("related")}>
          <h2 id={id("related")}>{t.page.related}</h2>
          <ul className={styles.cards}>
            {meta.related.map((related) => (
              <li key={related}>
                <Link href={paths.analysisConcept(related)} className={styles.conceptCard}>
                  <span className={styles.conceptTitle}>{t.titles[related]}</span>
                  <span className={styles.conceptSummary}>{conceptText(locale, related).summary}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>

        <p>
          <Link href={paths.analysisLearn()} className="btn btn--ghost btn--sm">
            {t.page.backToIndex}
          </Link>
        </p>
      </article>
    </ServerFrame>
  );
}
