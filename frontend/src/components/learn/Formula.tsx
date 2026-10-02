/**
 * A formula, drawn as text with real fractions, and read aloud as a sentence.
 *
 * No math library and no MathML: the formulas on these pages are fractions,
 * products and one exponent, which a few spans draw cleanly in both themes.
 * The drawing is `aria-hidden`; a screen reader gets the `spoken` sentence the
 * content file writes for it, which says the same thing in words. Renders on
 * the server — no hooks.
 */

import type { Formula as FormulaData, FormulaNode } from "../../lib/learn/content";
import styles from "./learn.module.css";

function Node({ node }: { node: FormulaNode }) {
  if (typeof node === "string") return <span>{node}</span>;
  if (Array.isArray(node)) {
    return (
      <>
        {node.map((child, index) => (
          <Node key={index} node={child} />
        ))}
      </>
    );
  }
  if ("frac" in node) {
    return (
      <span className={styles.frac}>
        <span className={styles.num}>
          <Node node={node.frac[0]} />
        </span>
        <span className={styles.den}>
          <Node node={node.frac[1]} />
        </span>
      </span>
    );
  }
  if ("sup" in node) {
    return (
      <sup>
        <Node node={node.sup} />
      </sup>
    );
  }
  return null;
}

export function Formula({ formula, whereLabel }: { formula: FormulaData; whereLabel: string }) {
  return (
    <figure className={styles.formula}>
      <p className={styles.formulaLine}>
        <span className={styles.srOnly}>{formula.spoken}</span>
        <span aria-hidden="true" className={styles.formulaMath}>
          <span className={styles.formulaName}>{formula.name}</span>
          <span className={styles.equals}>=</span>
          <Node node={formula.expression} />
        </span>
      </p>
      {formula.where && formula.where.length > 0 ? (
        <figcaption className={styles.where}>
          <span>{whereLabel}</span>
          <dl>
            {formula.where.map(([symbol, meaning]) => (
              <div key={symbol}>
                <dt>{symbol}</dt>
                <dd>{meaning}</dd>
              </div>
            ))}
          </dl>
        </figcaption>
      ) : null}
    </figure>
  );
}
