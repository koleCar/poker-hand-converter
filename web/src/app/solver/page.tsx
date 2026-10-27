import type { Metadata } from "next";
import { ServerFrame } from "../../components/shell/ServerFrame";
import { SolverLibrary } from "../../components/solver/SolverLibrary";
import { getDict } from "../../lib/i18n/server";
import { paths } from "../../lib/routes";
import styles from "../../components/learn/learn.module.css";

/**
 * The Solver library tab: the flop library's solves, one decision at a time.
 *
 * **Signed in only**, so `noindex` and out of the sitemap: the component
 * tells a signed-out visitor to sign in. The query picks the view
 * (`?set=` a table, `?line=` a library line, `?flop=` a canonical flop,
 * `?node=` a decision of its solve); anything malformed is the first of each.
 */

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const SET_RE = /^nlhe-cash-(hu|\d{1,2}max)-\d{1,3}bb$/;
const LINE_RE = /^[a-z0-9-]{2,24}$/;
const FLOP_RE = /^([2-9TJQKA][cdhs]){3}$/;
const NODE_RE = /^\d{1,4}$/;

export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return {
    title: en.meta.solver.title,
    description: en.meta.solver.description,
    alternates: { canonical: paths.solver() },
    robots: { index: false, follow: false },
  };
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? null;
const valid = (value: string | null, re: RegExp) => (value && re.test(value) ? value : null);

export default async function SolverPage({ searchParams }: PageProps) {
  const [en, query] = await Promise.all([getDict(), searchParams]);
  const node = valid(first(query.node), NODE_RE);
  const t = en.solver;
  return (
    <ServerFrame tab="solver">
      <div className={styles.page}>
        <header className={styles.pageHead}>
          <h1 className={styles.title}>{t.heading}</h1>
          <p className={styles.lead}>{t.intro}</p>
        </header>
        <SolverLibrary
          initialSet={valid(first(query.set), SET_RE)}
          initialLine={valid(first(query.line), LINE_RE)}
          initialFlop={valid(first(query.flop), FLOP_RE)}
          initialNode={node ? Number(node) : null}
        />
      </div>
    </ServerFrame>
  );
}
