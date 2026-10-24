'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { formatMoney } from '@3t/i18n';
import { AuthGate } from '@/components/auth-gate';
import { Alert, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';

interface Plan { id: string; code: string; deployment_mode: string; name: Record<string, string>; prices: { interval: string; amount_minor: string; currency: string }[] }
interface Template { id: string; slug: string; title: string; plans: Plan[] }

function Configure() {
  const { t, locale } = useT();
  const router = useRouter();
  const params = useSearchParams();
  const slug = params.get('template') ?? '';
  const [tpl, setTpl] = useState<Template | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!slug) return;
    void api<Template>(`/templates/${encodeURIComponent(slug)}?locale=${locale}`).then((res) => {
      if (res.ok) { setTpl(res.data); setSelected(res.data.plans[0]?.id ?? ''); } else setError(res.error);
    });
  }, [slug, locale]);

  async function continueToReview() {
    if (!tpl || !selected) return;
    setBusy(true); setError(null);
    const res = await api<{ id: string }>('/quotes', { method: 'POST', body: { template_id: tpl.id, plan_id: selected } });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    router.push(`/checkout/review?quote=${res.data.id}`);
  }

  if (!slug) return <p className="muted">{t('ui.checkout.no_template')}</p>;
  if (error && !tpl) return <ErrorState error={error} />;
  if (!tpl) return <Loading />;
  if (tpl.plans.length === 0) return <Alert tone="info"><p>{t('ui.detail.no_plans')}</p></Alert>;

  const firstCharge = (p: Plan) => p.prices.find((x) => x.interval === 'one_time') ?? p.prices[0];
  return (
    <div className="stack">
      <h1>{t('ui.checkout.configure_title')}</h1>
      <p className="muted">{tpl.title}</p>
      {error ? <ErrorState error={error} /> : null}
      <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="field"><strong>{t('ui.checkout.choose_plan')}</strong></legend>
        {tpl.plans.map((p) => {
          const price = firstCharge(p);
          return (
            <label key={p.id} className="card row" style={{ justifyContent: 'space-between', cursor: 'pointer' }}>
              <span className="row">
                <input type="radio" name="plan" value={p.id} checked={selected === p.id} onChange={() => setSelected(p.id)} />
                <span><strong>{p.name[locale] ?? p.name.vi ?? p.code}</strong> · {t(`ui.deployment.${p.deployment_mode}`)}</span>
              </span>
              <span className="tabular">{price ? formatMoney(price, locale) : '—'}</span>
            </label>
          );
        })}
      </fieldset>
      <div className="row">
        <button type="button" className="button" disabled={busy || !selected} onClick={() => void continueToReview()}>{busy ? t('ui.state.saving') : t('ui.checkout.continue')}</button>
        <Link href={`/${locale}/templates/${tpl.slug}`}>{t('ui.action.cancel')}</Link>
      </div>
    </div>
  );
}

export default function ConfigurePage() {
  return <AuthGate requireVerified>{() => <Suspense fallback={<Loading />}><Configure /></Suspense>}</AuthGate>;
}
