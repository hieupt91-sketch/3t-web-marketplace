'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { AuthGate } from '@/components/auth-gate';
import { MoneyLines, type QuoteLike } from '@/components/money-lines';
import { Alert, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import type { Me } from '@/lib/use-me';

interface Quote extends QuoteLike { id: string; deployment_mode: string; plan_name: Record<string, string>; expired: boolean }

function Review({ me }: { me: Me }) {
  const { t, locale } = useT();
  const router = useRouter();
  const quoteId = useSearchParams().get('quote') ?? '';
  const [quote, setQuote] = useState<Quote | null>(null);
  const [termsVersion, setTermsVersion] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!quoteId) return;
    void api<Quote>(`/quotes/${quoteId}`).then((res) => (res.ok ? setQuote(res.data) : setError(res.error)));
    void api<{ terms_version: string }>('/config/public').then((res) => res.ok && setTermsVersion(res.data.terms_version));
  }, [quoteId]);

  async function placeOrder() {
    if (!quote || !termsVersion || !accepted) return;
    setBusy(true); setError(null);
    const res = await api<{ id: string }>('/orders', { method: 'POST', body: { quote_id: quote.id, terms_version: termsVersion }, idempotencyKey: crypto.randomUUID() });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    router.push(`/checkout/orders/${res.data.id}/pay`);
  }

  if (error && !quote) return <ErrorState error={error} />;
  if (!quote) return <Loading />;

  return (
    <div className="stack">
      <h1>{t('ui.checkout.review_title')}</h1>
      {quote.expired ? <Alert tone="warning"><p>{t('error.quote.expired')}</p></Alert> : null}
      <div className="card stack">
        <h2 style={{ marginTop: 0 }}>{quote.plan_name[locale] ?? quote.plan_name.vi}</h2>
        <p className="muted">{t(`ui.deployment.${quote.deployment_mode}`)}</p>
        <MoneyLines quote={quote} locale={locale} />
      </div>
      <p className="muted">{t('ui.checkout.buyer', { email: me.email })}</p>
      {error ? <ErrorState error={error} /> : null}
      <label className="checkbox">
        <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
        <span>{t('ui.checkout.accept_terms')} (<a href={`/${locale}/policies/terms`} target="_blank" rel="noopener noreferrer">{t('ui.footer.terms')}</a>){termsVersion ? ` · ${termsVersion}` : ''}</span>
      </label>
      <div>
        <button type="button" className="button" disabled={busy || !accepted || quote.expired || !termsVersion} onClick={() => void placeOrder()}>{busy ? t('ui.state.saving') : t('ui.checkout.place_order')}</button>
      </div>
    </div>
  );
}

export default function ReviewPage() {
  return <AuthGate requireVerified>{(me) => <Suspense fallback={<Loading />}><Review me={me} /></Suspense>}</AuthGate>;
}
