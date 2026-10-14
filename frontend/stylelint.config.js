/* Stylelint exists here for one reason: to keep the token layering from #11
 * honest. Everything else it checks is a bonus.
 *
 * The two rules that matter:
 *
 *   1. No primitive tokens in `src/`. A component that writes `--n-800` has
 *      hard-coded a shade and silently opted out of every future theme; a
 *      component that writes `--border-default` has stated an intent, and an
 *      intent is the thing a theme can re-point.
 *
 *   2. No raw hex in `src/`. Same argument, one step cruder — see #56, which
 *      was ~94 of these.
 *
 * The token layer itself, and the felt, cards and chips that are exempt from
 * the hex rule, live in the shared UI package since R2.6
 * (`packages/ui/tokens/`, `replayer/replayer.css`, `cards/cards.css`), whose
 * own `stylelint.config.js` enforces the same two rules over the package.
 *
 * `color-no-hex` only catches hex. Raw `rgb()` / `hsl()` slip past it, and
 * there is no stock rule that catches them without also banning the
 * `color-mix(..., transparent)` form the themed alpha tints are built from.
 * The hex ban is what caught every literal in practice, so it is what is
 * enforced; a stricter function-level rule can follow if drift reappears.
 */
export default {
  extends: ["stylelint-config-standard"],

  rules: {
    /* BEM. `conv-drop__icon` and `btn--primary` are the house style and are
       not up for renegotiation by a linter default. */
    "selector-class-pattern": null,

    /* `--font-size-2xs`, `--space-0-5`, `--radius-1`: the token names are
       deliberate and the stock kebab-case pattern rejects a digit after a
       hyphen. */
    "custom-property-pattern": null,
    "keyframes-name-pattern": null,

    /* Fires on the legitimate ordering of `.btn` / `.btn:hover` / `.btn--x`
       families, where the "descending" selector is the one that has to win. */
    "no-descending-specificity": null,

    /* `transition: a 120ms ease, b 120ms ease` on one line is more readable
       than four, and `font: inherit` next to `font-size` is intentional. */
    "declaration-block-no-redundant-longhand-properties": null,
    "value-keyword-case": null,

    /* The replayer computes seat positions from percentages that genuinely
       need more than four decimal places. */
    "number-max-precision": null,

    /* Empty lines inside a long declaration list are how the sheets group
       related properties; the stock rule wants them gone. */
    "declaration-empty-line-before": null,
    "custom-property-empty-line-before": null,
    "comment-empty-line-before": null,
    "rule-empty-line-before": null,
    "at-rule-empty-line-before": null,
    "media-feature-range-notation": null,
    "alpha-value-notation": null,
    "color-function-notation": null,
    "shorthand-property-no-redundant-values": null,

    /* Vite resolves bare `@import "./x.css"`; wrapping them in `url()` is the
       CSS spec's preference and the bundler's loss. */
    "import-notation": null,

    /* The ramps are written at full length because they are read as a table;
       the table files write `#fff` because a card's ink is white. Both are
       fine, and neither is worth a lint failure. */
    "color-hex-length": null,

    /* `semantic.css` opens a second `:root` for the legacy alias block on
       purpose, so the block can be deleted in one cut. */
    "no-duplicate-selectors": null,

    /* `word-break: break-word` is deprecated but not equivalent to any single
       modern replacement in every engine, and swapping it is a rendering
       change rather than a lint fix. */
    "declaration-property-value-keyword-no-deprecated": null,
  },

  overrides: [
    {
      /* `styles/fonts.css` was lifted verbatim out of the old `index.html`
         <style> block at the Next.js move — same declarations, same order, same
         measured numbers — and it was never linted there, because it was HTML.

         The one rule it trips is `font-family-name-quotes`, which wants
         `Inter` unquoted because the identifier needs no quotes. The house
         convention is the opposite: `semantic.css` writes
         `--font-family-sans: "Inter", …`, and stylelint does not check custom
         property values, so it has never been asked. Unquoting here to satisfy
         a rule would make the one file that declares the face disagree with the
         token that names it. */
      files: ["src/styles/fonts.css"],
      rules: {
        "font-family-name-quotes": null,
      },
    },

    {
      files: ["src/**/*.css"],
      rules: {
        "color-no-hex": true,

        /* The primitive ramps, spelled out rather than by prefix: `--chip-w`
           is a local card-geometry variable in the package's cards.css and `--chip-denom-*`
           is a semantic token, so a bare `--chip-` prefix would be wrong. */
        "declaration-property-value-disallowed-list": {
          "/.*/": [
            "/var\\(\\s*--(?:[namfw]-[0-9]|st-|ink-|chip-(?:white|red|blue|green|black|purple|gold))/",
          ],
        },
      },
    },
  ],
};
