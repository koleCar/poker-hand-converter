import type { Metadata } from "next";
import { ServerFrame } from "../../components/shell/ServerFrame";
import { WebSolverLibrary } from "../../components/solver/WebSolverLibrary";
import { getDict } from "../../lib/i18n/server";
import { paths } from "../../lib/routes";
import styles from "../../components/solver/solver.module.css";

/**
 * The Solver library tab: the flop library's solves, one decision at a time.
 *
 * **Public and indexable**, like `/analysis/charts`: the solves are our own
 * data and the page reads no account, so a signed-out reader and a crawler
 * see what a signed-in player sees. `sitemap.ts` lists it and the canonical
 * URL drops the query, which picks the view (`?set=` a table, `?line=` the
 * preflop line in the charts' letters, `?flop=` the flop as picked, any suits,
 * `?node=` a decision of its solve); anything malformed is the start of each.
 * Edge to edge (`ServerFrame wide`): the grid is the page.
 */

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const SET_RE = /^nlhe-cash-(hu|\d{1,2}max)-\d{1,3}bb$/;
const LINE_RE = /^[fkcra]{1,24}$/;
const FLOP_RE = /^([2-9TJQKA][cdhs]){3}$/;
const NODE_RE = /^\d{1,5}$/;
/** A turn: a full solve's file (`X-B1.82-C~Kd`, local only) or a live turn's deal node and card (`12~Kd`). */
const TURN_RE = /^[A-Za-z0-9._-]{1,60}~[2-9TJQKA][cdhs]$/;

export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return {
    title: en.meta.solver.title,
    description: en.meta.solver.description,
    alternates: { canonical: paths.solver() },
    openGraph: { title: en.meta.solver.title, description: en.meta.solver.description, url: paths.solver() },
  };
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? null;
const valid = (value: string | null, re: RegExp) => (value && re.test(value) ? value : null);

export default async function SolverPage({ searchParams }: PageProps) {
  const [en, query] = await Promise.all([getDict(), searchParams]);
  const node = valid(first(query.node), NODE_RE);
  const t = en.solver;
  return (
    <ServerFrame tab="solver" wide>
      <div className={styles.page}>
        <header className={styles.pageHead}>
          <h1>{t.heading}</h1>
          <p>{t.intro}</p>
        </header>
        <WebSolverLibrary
          initialSet={valid(first(query.set), SET_RE)}
          initialLine={valid(first(query.line), LINE_RE)}
          initialFlop={valid(first(query.flop), FLOP_RE)}
          initialNode={node ? Number(node) : null}
          initialTurn={valid(first(query.turn), TURN_RE)}
        />
      </div>
    </ServerFrame>
  );
}
