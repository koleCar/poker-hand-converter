import type { Metadata } from "next";
import { DownloadPage } from "../../components/download/DownloadPage";
import { ServerFrame } from "../../components/shell/ServerFrame";
import { getDict, getLocale } from "../../lib/i18n/server";
import { paths } from "../../lib/routes";

/**
 * The desktop app for macOS and Windows (the bar's "Get the app"). Public and
 * indexable; its share card is the promo picture in the reader's language.
 */
export async function generateMetadata(): Promise<Metadata> {
  const [en, locale] = await Promise.all([getDict(), getLocale()]);
  const image = { url: `/download/rail-app-promo.${locale}.png`, width: 1200, height: 630, alt: en.download.promoAlt };
  return {
    title: en.download.metaTitle,
    description: en.download.metaDescription,
    alternates: { canonical: paths.download() },
    openGraph: { title: en.download.metaTitle, description: en.download.metaDescription, images: [image] },
    twitter: { card: "summary_large_image", images: [image.url] },
  };
}

export default async function Download() {
  const [en, locale] = await Promise.all([getDict(), getLocale()]);
  return (
    <ServerFrame tab={null}>
      <DownloadPage en={en} locale={locale} />
    </ServerFrame>
  );
}
