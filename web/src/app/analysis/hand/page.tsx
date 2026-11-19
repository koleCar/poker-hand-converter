import type { Metadata } from "next";
import { HandByKeyScreen } from "./HandByKeyScreen";
import { getDict } from "../../../lib/i18n/server";

/**
 * A hand of the reader's library by its dedupe key (`hands.hand_key`,
 * `pokerstars:123…`): the desktop app's "Open on the web", which knows the
 * key and not the row's id. The client looks the key up under RLS and
 * replaces the address with `/analysis/h/<id>` (the replayer position `?t=`
 * carried on); a key not in the library yet says so. Never indexed.
 */

const KEY_RE = /^[^\s]{1,200}$/;
const T_RE = /^[a-z0-9:-]{1,40}$/i;

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return {
    title: en.meta.analysisHand.title,
    description: en.meta.analysisHand.description,
    robots: { index: false, follow: false },
  };
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? null;

export default async function HandByKeyPage({ searchParams }: PageProps) {
  const query = await searchParams;
  const key = first(query.key);
  const t = first(query.t);
  return <HandByKeyScreen handKey={key && KEY_RE.test(key) ? key : null} position={t && T_RE.test(t) ? t : null} />;
}
