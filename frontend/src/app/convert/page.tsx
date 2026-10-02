import type { Metadata } from "next";
import { ConvertScreen } from "./ConvertScreen";
import { getDict } from "../../lib/i18n/server";
import { paths } from "../../lib/routes";

/**
 * The converter.
 *
 * ## THIS ROUTE MAKES ZERO SERVER REQUESTS. Keep it that way.
 *
 * Hand histories never leave the tab. A file dropped here is read with
 * `FileReader`, decoded in `converter/inputs.ts`, detected and parsed by
 * `lib/parsers/`, serialized by `lib/phf/serialize.ts` and handed back as a
 * `Blob` download — all of it inside the browser, none of it through anything
 * of ours. The only network traffic this page can generate is (a) the app's own
 * JavaScript, and (b) an *explicit, opt-in* save to the user's library when
 * they are signed in and have left "Save to my library" on.
 *
 * That is not incidental. A hand history is a record of who someone played
 * against, for how much, and how well; people are right to be careful with it,
 * and "we do not receive it" is a stronger promise than any retention policy.
 * It is also a real differentiator — the competing converters are uploads.
 *
 * A framework migration is exactly when this gets broken by accident, which is
 * why it is written down twice: here, and as a line of UI copy on the page
 * (`en.convert.privacy`) so a change that breaks it also makes the app tell a
 * lie somebody can see. Concretely, do not:
 *
 *  * turn any of this into a Server Action or a Route Handler taking hand text;
 *  * add analytics that carry file names, hand ids or counts derived from
 *    content;
 *  * "just" send a failed parse somewhere for debugging — the failure corpus is
 *    the user's own row, written by the user's own session, under RLS.
 *
 * ## The other reason this route came first
 *
 * `components/converter/conversionClient.ts` constructs
 * `new Worker(new URL("../../workers/convert.worker.ts", import.meta.url))`.
 * That is the bundler-agnostic form; webpack 5 parses it statically. Three
 * conditions hold and must keep holding: it is imported only from a
 * `"use client"` boundary, `converter/pipeline.ts` stays DOM-free (its header
 * says so — that comment is load-bearing for the framework now, not just for
 * the fallback path), and the worker URL is relative to the importing module.
 */
export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return {
    title: en.meta.convert.title,
    description: en.meta.convert.description,
    alternates: { canonical: paths.convert() },
    openGraph: {
      title: en.meta.convert.title,
      description: en.meta.convert.description,
      url: paths.convert(),
    },
  };
}

export default function ConvertPage() {
  return <ConvertScreen />;
}
