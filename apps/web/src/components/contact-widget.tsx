import { translate, type Locale } from '@3t/i18n';
import { fetchPublic } from '@/lib/api-server';

interface PublicConfig {
  contact?: { phone?: string | null; zalo?: string | null; messenger?: string | null; email?: string | null } | null;
}

function telHref(phone: string): string {
  const digits = phone.replace(/[^0-9+]/g, '');
  return `tel:${digits}`;
}

/** Always-visible contact widget, rendered on every page from the root
 *  layout. Channels come from the admin contact settings; a channel that
 *  has not been configured is simply hidden, and the contact-form link is
 *  always shown so the widget is never empty. */
export async function ContactWidget({ locale }: { locale: Locale }) {
  const t = (key: string) => translate(locale, key);
  const result = await fetchPublic<PublicConfig>('/config/public', locale);
  const contact = result.ok ? result.data.contact ?? {} : {};
  const phone = contact.phone?.trim() || null;
  const zalo = contact.zalo?.trim() || null;
  const messenger = contact.messenger?.trim() || null;
  const email = contact.email?.trim() || null;
  return (
    <nav className="contact-widget" aria-label={t('ui.contact.widget_title')}>
      {phone ? <a className="button button--secondary" href={telHref(phone)}>{t('ui.contact.call')}: {phone}</a> : null}
      {zalo ? <a className="button button--secondary" href={`https://zalo.me/${encodeURIComponent(zalo)}`} target="_blank" rel="noopener noreferrer nofollow">{t('ui.contact.zalo_chat')}</a> : null}
      {messenger ? <a className="button button--secondary" href={`https://m.me/${encodeURIComponent(messenger)}`} target="_blank" rel="noopener noreferrer nofollow">{t('ui.contact.messenger_chat')}</a> : null}
      {email ? <a className="button button--secondary" href={`mailto:${email}`}>{email}</a> : null}
      <a className="button" href={`/${locale}/contact`}>{t('ui.contact.form_link')}</a>
    </nav>
  );
}
