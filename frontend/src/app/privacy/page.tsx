import type { Metadata } from "next";
import { LegalDocument } from "../../components/legal/LegalDocument";
import { ServerFrame } from "../../components/shell/ServerFrame";
import { getDict, getLocale } from "../../lib/i18n/server";
import { paths } from "../../lib/routes";

/**
 * The privacy policy (Rail R6.5), from `docs/legal/PRIVACY.md` /
 * `PRIVACY.hr.md` in the reader's language. A draft until the owner's and
 * the legal review: the page says so above the text, and asks not to be
 * indexed.
 */
export async function generateMetadata(): Promise<Metadata> {
  const en = await getDict();
  return {
    title: en.legal.privacyTitle,
    description: en.legal.privacyDescription,
    alternates: { canonical: paths.privacy() },
    robots: { index: false, follow: true },
  };
}

export default async function PrivacyPage() {
  const [en, locale] = await Promise.all([getDict(), getLocale()]);
  return (
    <ServerFrame tab={null}>
      <LegalDocument id="privacy" locale={locale} draft={en.legal.draft} />
    </ServerFrame>
  );
}
