import type { Metadata } from "next";
import Link from "next/link";
import { AnalysisNav } from "../../../components/analysis/AnalysisNav";
import { ServerFrame } from "../../../components/shell/ServerFrame";
import { getDict, getLocale } from "../../../lib/i18n/server";
import { CONCEPT_GROUPS, CONCEPTS, conceptsIn } from "../../../lib/learn/concepts";
import { conceptText } from "../../../lib/learn/content";
import { paths } from "../../../lib/routes";
import styles from "../../../components/learn/learn.module.css";

/**
 * The concept library's index (`docs/ANALYSIS-PLAN.md` §6.0 *Learn*).
 *
 * **Public and indexable**, unlike the rest of `/analysis`: it reads no
 * account, no hand and no row — only the catalogue and the texts that ship
 * with the app — so a signed-out reader and a crawler see exactly what a
 * signed-in player sees. `robots.ts` allows this subtree inside the otherwise
 * disallowed `/analysis`, and `sitemap.ts` lists every page.
 */

export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return {
    title: en.meta.learn.title,
    description: en.meta.learn.description,
    alternates: { canonical: paths.analysisLearn() },
    openGraph: {
      title: en.meta.learn.title,
      description: en.meta.learn.description,
      url: paths.analysisLearn(),
    },
  };
}

export default async function LearnIndexPage() {
  const [en, locale] = await Promise.all([getDict(), getLocale()]);
  const t = en.learn;
  return (
    <ServerFrame tab="analysis">
      <div className={styles.page}>
        <header className={styles.pageHead}>
          <h1 className={styles.title}>{t.index.heading}</h1>
          <AnalysisNav current="learn" />
          <p className={styles.lead}>{t.index.intro}</p>
        </header>
        {CONCEPT_GROUPS.map((group) => (
          <section key={group} className={styles.group} aria-labelledby={`group-${group}`}>
            <h2 id={`group-${group}`} className={styles.groupTitle}>
              {t.index.groups[group]}
            </h2>
            <ul className={styles.cards}>
              {conceptsIn(group).map((id) => (
                <li key={id}>
                  <Link href={paths.analysisConcept(id)} className={styles.conceptCard}>
                    <span className={styles.conceptTitle}>{t.titles[id]}</span>
                    <span className={styles.conceptSummary}>{conceptText(locale, id).summary}</span>
                    {CONCEPTS[id].widget ? <span className={styles.badge}>{t.index.interactive}</span> : null}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </ServerFrame>
  );
}
