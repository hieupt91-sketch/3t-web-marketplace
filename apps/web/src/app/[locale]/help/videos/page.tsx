import type { Metadata } from 'next';
import Link from 'next/link';
import { translate, type Locale } from '@3t/i18n';
import { GUIDE_VIDEOS, youtubeEmbedUrl } from '@/lib/guide-videos';
import { languageAlternates } from '@/lib/seo';

type Props = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  return {
    title: translate(locale, 'ui.help.videos_title'),
    description: translate(locale, 'ui.help.videos_intro'),
    alternates: { canonical: `/${locale}/help/videos`, languages: languageAlternates('/help/videos') },
  };
}

/**
 * Tutorial videos — a dedicated static page (guide-plan.md, Option B): help
 * articles render through the restricted RichText subset, which can never
 * carry an iframe, so the videos live here as youtube-nocookie embeds.
 * Entries in guide-videos.ts whose youtubeId is still empty render a
 * placeholder panel instead of an embed.
 */
export default async function HelpVideos({ params }: Props) {
  const { locale } = await params;
  const t = (k: string, params?: Record<string, string | number>) => translate(locale, k, params);
  return (
    <div className="container stack">
      <p><Link href={`/${locale}/help`}>← {t('ui.help.title')}</Link></p>
      <h1>{t('ui.help.videos_title')}</h1>
      <p className="muted">{t('ui.help.videos_intro')}</p>
      <div className="video-grid">
        {GUIDE_VIDEOS.map((video) => {
          const title = t(video.titleKey);
          return (
            <section key={video.slug} id={`video-${video.slug}`} className="video-card">
              {video.youtubeId ? (
                <div className="video-embed">
                  <iframe
                    src={youtubeEmbedUrl(video.youtubeId)}
                    title={title}
                    loading="lazy"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                    allowFullScreen
                    referrerPolicy="strict-origin-when-cross-origin"
                  />
                </div>
              ) : (
                <div className="video-embed video-embed--placeholder">
                  <p>{t('ui.help.videos_placeholder')}</p>
                </div>
              )}
              <h2>
                <span className="video-card__part">{t('ui.help.videos_part', { part: video.part })}</span>{' '}
                {title}
              </h2>
              <p className="muted">{t(video.descriptionKey)}</p>
            </section>
          );
        })}
      </div>
    </div>
  );
}
