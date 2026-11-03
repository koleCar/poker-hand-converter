import { APP_RELEASES_URL } from "../../lib/download";
import type { Dict, Locale } from "../../lib/i18n/types";
import { DownloadButtons } from "./DownloadButtons";
import styles from "./download.module.css";

/**
 * `/download`: the desktop app in one screen - the promo picture, what the
 * app does, the two installers and what to expect the first time it opens
 * (the builds are not signed yet, docs/RAIL-PLAN.md P3/P4).
 *
 * The picture is `public/download/rail-app-promo.<locale>.*`, drawn by
 * `scripts/app-promo/` (a drawing of the app, not a screenshot).
 */
export function DownloadPage({ en, locale }: { en: Dict; locale: Locale }) {
  const t = en.download;
  return (
    <article className={styles.page}>
      <header className={styles.hero}>
        <h1 className={styles.heading}>{t.heading}</h1>
        <p className={styles.lede}>{t.lede}</p>
        <DownloadButtons />
        <p className={styles.free}>{t.free}</p>
      </header>

      <picture className={styles.promo}>
        <source srcSet={`/download/rail-app-promo.${locale}.webp`} type="image/webp" />
        {/* A plain <picture>: a static image with its own WebP, nothing for next/image to resize. */}
        <img src={`/download/rail-app-promo.${locale}.png`} alt={t.promoAlt} width={1200} height={630} />
      </picture>

      <ul className={styles.features}>
        {t.features.map((feature) => (
          <li key={feature.title} className={`card ${styles.feature}`}>
            <h2>{feature.title}</h2>
            <p>{feature.body}</p>
          </li>
        ))}
      </ul>

      <section className={`card ${styles.firstOpen}`} aria-labelledby="download-first-open">
        <h2 id="download-first-open">{t.firstOpen.heading}</h2>
        <dl>
          <dt>{t.mac.name}</dt>
          <dd>{t.firstOpen.mac}</dd>
          <dt>{t.windows.name}</dt>
          <dd>{t.firstOpen.windows}</dd>
        </dl>
        <a className={styles.releases} href={APP_RELEASES_URL}>
          {t.allReleases}
        </a>
      </section>
    </article>
  );
}
