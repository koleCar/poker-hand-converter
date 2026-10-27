/* The web's token rules (`web/stylelint.config.js`), for the package that
 * now holds the token layer:
 *
 *   1. no primitive tokens (`--n-800`) outside `tokens/`;
 *   2. no raw hex outside `tokens/`.
 *
 * A component states an intent (`--border-default`), which a theme can
 * re-point; a shade is an opt-out from every theme. The relaxations are the
 * web's, for the same house style - the global sheets that moved here
 * (controls, cards, replayer, overlay, stat tile) are its BEM, unchanged.
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
      files: ["**/*.css"],
      rules: {
        "color-no-hex": true,
        /* The primitive ramps, spelled out rather than by prefix: `--chip-w`
           is a local card-geometry variable in cards.css and `--chip-denom-*`
           is a semantic token. */
        "declaration-property-value-disallowed-list": {
          "/.*/": ["/var\\(\\s*--(?:[namfw]-[0-9]|st-|ink-|chip-(?:white|red|blue|green|black|purple|gold))/"],
        },
      },
    },
    {
      /* The token layer is the one place a colour is a value rather than a
         reference. */
      files: ["tokens/**/*.css"],
      rules: {
        "color-no-hex": null,
        "declaration-property-value-disallowed-list": null,
      },
    },
    {
      /* The felt, the cards and the chips are deliberately unthemed (#11): a
         poker table is a physical object the UI is showing you, not a surface
         the UI owns. Exempt from the hex rule only - they still may not reach
         into the primitive ramps. */
      files: ["replayer/replayer.css", "cards/cards.css"],
      rules: {
        "color-no-hex": null,
      },
    },
  ],
};
