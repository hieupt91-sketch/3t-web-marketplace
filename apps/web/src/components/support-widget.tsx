import { type Locale } from '@3t/i18n';
import { fetchPublic } from '@/lib/api-server';
import { SupportWidgetClient, type ContactChannels } from '@/components/support-widget-client';

interface PublicConfig {
  contact?: { phone?: string | null; zalo?: string | null; messenger?: string | null; email?: string | null } | null;
}

/** HELP-05 (docs/12 §13): ONE floating support entry point. The server
 *  half resolves the admin-configured contact channels so the client
 *  panel renders instantly; a channel that has not been configured is
 *  simply absent, and the contact-form link is always present so the
 *  panel is never empty. */
export async function SupportWidget({ locale }: { locale: Locale }) {
  const result = await fetchPublic<PublicConfig>('/config/public', locale);
  const raw = result.ok ? result.data.contact ?? {} : {};
  const contact: ContactChannels = {
    phone: raw.phone?.trim() || null,
    zalo: raw.zalo?.trim() || null,
    messenger: raw.messenger?.trim() || null,
    email: raw.email?.trim() || null,
  };
  return <SupportWidgetClient locale={locale} contact={contact} />;
}
