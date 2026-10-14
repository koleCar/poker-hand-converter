/* The token rules of the web (`frontend/stylelint.config.js`), for the app:
 *
 *   1. no primitive tokens (`--n-800`) in `src/`;
 *   2. no raw hex in `src/`.
 *
 * The token layer itself is the shared UI package's (`packages/ui/tokens/`,
 * R2.6), linted there by the same rules. A component states an intent
 * (`--border-default`), which a theme can re-point; a shade is an opt-out from
 * every theme. The relaxations below are the web's, for the same house style
 * (BEM-free here, since CSS Modules scope the names, but the token names need
 * them).
 */
export default {
  extends: ["stylelint-config-standard"],

  rules: {
    "selector-class-pattern": null,
    "custom-property-pattern": null,
    "keyframes-name-pattern": null,
    "no-descending-specificity": null,
    "declaration-block-no-redundant-longhand-properties": null,
    "value-keyword-case": null,
    "number-max-precision": null,
    "declaration-empty-line-before": null,
    "custom-property-empty-line-before": null,
    "comment-empty-line-before": null,
    "rule-empty-line-before": null,
    "at-rule-empty-line-before": null,
    "media-feature-range-notation": null,
    "alpha-value-notation": null,
    "color-function-notation": null,
    "shorthand-property-no-redundant-values": null,
    "import-notation": null,
    "color-hex-length": null,
    "no-duplicate-selectors": null,
    "declaration-property-value-keyword-no-deprecated": null,
  },

  overrides: [
    {
      files: ["src/**/*.css"],
      rules: {
        "color-no-hex": true,
        "declaration-property-value-disallowed-list": {
          "/.*/": ["/var\\(\\s*--(?:[namfw]-[0-9]|st-|ink-|chip-(?:white|red|blue|green|black|purple|gold))/"],
        },
      },
    },
  ],
};
