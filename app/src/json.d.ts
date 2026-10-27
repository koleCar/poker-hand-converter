/**
 * (R5.4) The preflop chart sets the web's library imports
 * (`web/src/lib/charts/registry.ts`: one dynamic import of JSON per
 * set, ~31 MB in all). The library types what it reads of them itself
 * (`load: () => Promise<unknown>`), so the app's typecheck does not read
 * the files: any JSON module is `unknown` here.
 */
declare module "*.json" {
  const value: unknown;
  export default value;
}
