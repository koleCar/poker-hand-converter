/**
 * Stylesheet imports, for the package's own typecheck. Each consumer declares
 * the same through its bundler's types (Next's `*.module.css`, Vite's
 * `vite/client`); this file is not imported by them.
 */
declare module "*.module.css" {
  const classes: { readonly [key: string]: string };
  export default classes;
}

declare module "*.css";
