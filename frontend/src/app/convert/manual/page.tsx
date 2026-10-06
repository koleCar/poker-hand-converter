import type { Metadata } from "next";
import { ManualHandScreen } from "./ManualHandScreen";
import { getDict } from "../../../lib/i18n/server";
import { paths } from "../../../lib/routes";

/**
 * Manual hand entry.
 *
 * Same standing rule as `/convert` next door (see its `page.tsx`): this route
 * makes no server requests with hand data. The hand is built in the browser
 * (`lib/manual/`), kept in this browser's `localStorage` until it is finished,
 * and only leaves the tab on an explicit save to the user's library.
 */
export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return {
    title: en.meta.convertManual.title,
    description: en.meta.convertManual.description,
    alternates: { canonical: paths.convertManual() },
    openGraph: {
      title: en.meta.convertManual.title,
      description: en.meta.convertManual.description,
      url: paths.convertManual(),
    },
  };
}

export default function ConvertManualPage() {
  return <ManualHandScreen />;
}
