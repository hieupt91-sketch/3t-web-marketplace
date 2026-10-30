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
  const external = side.link_url !== null && /^https?:\/\//i.test(side.link_url);
  const img = <img src={side.image_url} alt={side.alt} width={160} height={600} loading="lazy" />;
  return (
    <aside className={`side-rail side-rail--${position}`} aria-label={side.alt || 'Advertisement'}>
      {side.link_url ? (
        <a href={side.link_url} {...(external ? { target: '_blank', rel: 'sponsored noopener noreferrer' } : {})}>
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
