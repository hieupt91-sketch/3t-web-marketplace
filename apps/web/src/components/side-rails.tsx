import type { Locale } from '@3t/i18n';
import { fetchPublic } from '@/lib/api-server';

interface AdSide {
  image_url: string;
  link_url: string | null;
  alt: string;
}

interface PublicAds {
  left: AdSide | null;
  right: AdSide | null;
}

function Rail({ side, position }: { side: AdSide; position: 'left' | 'right' }) {
  const link = side.link_url;
  // Same classification as RichText (UI-LOW-01 family): internal is a single
  // leading `/` not followed by `/` or `\`; protocol-relative URLs (`//host`,
  // `/\host`) are external and must get the sponsored _blank treatment, and
  // non-http(s) schemes (javascript:/data:…) never render as a link at all —
  // the banner then shows unlinked, like RichText degrading unsafe links.
  const internal = link !== null && link.startsWith('/') && link[1] !== '/' && link[1] !== '\\';
  const external = link !== null && !internal && (/^https?:\/\//i.test(link) || link.startsWith('//') || link.startsWith('/\\'));
  const img = <img src={side.image_url} alt={side.alt} width={160} height={600} loading="lazy" />;
  return (
    <aside className={`side-rail side-rail--${position}`} aria-label={side.alt || 'Advertisement'}>
      {internal || external ? (
        <a href={link!} {...(external ? { target: '_blank', rel: 'sponsored noopener noreferrer' } : {})}>
          {img}
        </a>
      ) : (
        img
      )}
    </aside>
  );
}

/**
 * Advertising rails in the empty margins of very wide screens. The
 * public config exposes a side only when the owner enabled ads in
 * admin AND uploaded that side's banner, so unconfigured slots render
 * nothing at all — no empty frames. CSS shows them from 1800px up,
 * where the 1440px banner column leaves a true margin.
 */
export async function SideRails({ locale }: { locale: Locale }) {
  const cfg = await fetchPublic<{ ads?: PublicAds }>('/config/public', locale);
  const ads = cfg.ok ? cfg.data.ads : undefined;
  if (!ads || (!ads.left && !ads.right)) return null;
  return (
    <>
      {ads.left ? <Rail side={ads.left} position="left" /> : null}
      {ads.right ? <Rail side={ads.right} position="right" /> : null}
    </>
  );
}
