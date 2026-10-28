'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatMoney } from '@3t/i18n';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import type { TemplateSummary } from '@/lib/api-server';
import { ErrorState, Loading } from '@/components/ui';
import { buildSetupGuide, type SetupDomain, type SetupGuideStrings, type SetupHosting } from '@/lib/setup-guide';

/** Owner-confirmed 2026-10-28: subdomains are <name>.webmaket.com. The
 *  subdomain fee itself is owner-set in admin (/admin/settings/subdomain-fee)
 *  and read from /config/public; the wizard never invents it. */
const SUBDOMAIN_BASE = 'webmaket.com';

function formatSize(sizeBytes: string): string {
  const n = Number(sizeBytes);
  if (!Number.isFinite(n)) return sizeBytes;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

interface SubCheck { available: boolean; reason: string | null }
interface ConnResult { hostname: string; dns_ok: boolean; addresses: number; private: boolean; http_ok: boolean; http_status: number | null }

/**
 * Post-purchase setup wizard, shown on the downloads page for self-host
 * entitlements: a visual path from purchase to a running site for buyers
 * who know no tech. Step 1 asks the domain question (own domain = skip the
 * subdomain step; 3T subdomain = pick a name and check it against the
 * platform registry, fee owner-set; free host address = skip). Step 2 asks
 * where to host (own VPS = self-deploy guide; free suggestion = Pages for
 * static, a suitable free VPS + capacity note for admin sites). Step 3,
 * only for VPS hosting, is the connection check for the "our subdomain +
 * customer's other VPS" case: DNS resolution and HTTPS from the server,
 * plus the 4-step DNS/firewall/cert guide. Step 4 summarizes the choices
 * and downloads a personalized guide; the page's own demo/clean buttons
 * below supply the template package itself.
 */
export function SetupWizard({ slug, version }: { slug: string; version: string }) {
  const { t, locale } = useT();
  const [summary, setSummary] = useState<TemplateSummary | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [step, setStep] = useState(1);
  const [domain, setDomain] = useState<SetupDomain | null>(null);
  const [ownHostname, setOwnHostname] = useState('');
  const [subLabel, setSubLabel] = useState('');
  const [subCheck, setSubCheck] = useState<SubCheck | null>(null);
  const [subBusy, setSubBusy] = useState(false);
  const [subError, setSubError] = useState<ApiError | null>(null);
  const [hosting, setHosting] = useState<SetupHosting | null>(null);
  const [connHostname, setConnHostname] = useState('');
  const [connIp, setConnIp] = useState('');
  const [connResult, setConnResult] = useState<ConnResult | null>(null);
  const [connBusy, setConnBusy] = useState(false);
  const [connError, setConnError] = useState<ApiError | null>(null);
  const [variant, setVariant] = useState<'demo' | 'clean'>('demo');
  const [fee, setFee] = useState<{ amount_minor: number | null; period: string } | null>(null);
  const [feeCurrency, setFeeCurrency] = useState('VND');

  const load = useCallback(async () => {
    const res = await api<TemplateSummary>(`/templates/${slug}`);
    if (res.ok) { setSummary(res.data); setLoadError(null); } else setLoadError(res.error);
    void api<{ subdomain_fee: { amount_minor: number | null; period: string } | null; currency: string }>(`/config/public`).then((cfg) => {
      if (cfg.ok) {
        setFee(cfg.data.subdomain_fee);
        if (cfg.data.currency) setFeeCurrency(cfg.data.currency);
      }
    });
  }, [slug]);
  useEffect(() => { void load(); }, [load]);

  const subdomainHostname = subLabel.trim().toLowerCase() ? `${subLabel.trim().toLowerCase()}.${SUBDOMAIN_BASE}` : '';
  const derivedHostname = domain === 'subdomain' ? subdomainHostname : domain === 'own' ? ownHostname.trim() : '';
  const showConnection = hosting === 'vps';
  const packageStep = showConnection ? 4 : 3;
  const isStatic = summary ? summary.adapter === 'static-html' || summary.adapter === 'vite-static' : true;
  const sizeLabel = summary?.size_bytes ? formatSize(summary.size_bytes) : null;
  const feeNote = fee && fee.amount_minor !== null
    ? t('ui.setup.subdomain_fee', { fee: formatMoney({ amount_minor: String(fee.amount_minor), currency: feeCurrency }, locale), period: fee.period === 'monthly' ? t('ui.setup.fee_monthly') : t('ui.setup.fee_once') })
    : t('ui.setup.subdomain_fee_note');

  async function checkSubdomain() {
    setSubBusy(true); setSubError(null);
    const res = await api<SubCheck>(`/sites/check-subdomain?subdomain=${encodeURIComponent(subLabel.trim().toLowerCase())}`);
    setSubBusy(false);
    if (res.ok) setSubCheck(res.data); else setSubError(res.error);
  }

  async function checkConnection() {
    const target = connHostname.trim() || derivedHostname;
    if (!target) return;
    setConnBusy(true); setConnError(null);
    const res = await api<ConnResult>(`/sites/connection-check?hostname=${encodeURIComponent(target.toLowerCase())}`);
    setConnBusy(false);
    if (res.ok) setConnResult(res.data); else setConnError(res.error);
  }

  function downloadGuide() {
    if (!domain || !hosting) return;
    const strings: SetupGuideStrings = {
      intro: t('ui.setup.g_intro'),
      titleDomain: t('ui.setup.g_t_domain'),
      titleHosting: t('ui.setup.g_t_hosting'),
      titleConnection: t('ui.setup.g_t_connection'),
      titleFinal: t('ui.setup.g_t_final'),
      domainOwnNote: t('ui.setup.domain_own_note'),
      domainSubNote: t('ui.setup.domain_sub_note'),
      domainFreeNote: t('ui.setup.domain_free_note'),
      hostingVpsNote: t('ui.setup.hosting_vps_note'),
      freeStaticBody: t('ui.setup.free_static_body'),
      freeRuntimeBody: t('ui.setup.free_runtime_body'),
      capacityNote: t('ui.setup.capacity_note'),
      connectionGuide: t('ui.setup.connection_guide'),
      finalDemo: t('ui.setup.g_final_demo'),
      finalClean: t('ui.setup.g_final_clean'),
      subdomainFeeNote: feeNote,
      ownHostnameLine: t('ui.setup.g_own_host'),
      subHostnameLine: t('ui.setup.g_sub_host'),
      vpsIpLine: t('ui.setup.g_vps_ip'),
    };
    let connectionLine: string | null = null;
    if (connResult) {
      const dnsText = connResult.private
        ? t('ui.setup.connection_private')
        : connResult.dns_ok
          ? t('ui.setup.connection_dns_ok', { count: String(connResult.addresses) })
          : t('ui.setup.connection_dns_fail');
      const httpText = connResult.http_ok
        ? t('ui.setup.connection_http_ok', { status: String(connResult.http_status) })
        : t('ui.setup.connection_http_fail');
      connectionLine = `${connResult.hostname}: ${dnsText} ${httpText}`;
    }
    const md = buildSetupGuide({
      slug, version, isStatic, sizeLabel, domain,
      ownHostname: ownHostname.trim(), subdomainHostname, hosting, variant, vpsIp: connIp.trim(),
      connectionLine, s: strings,
    });
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = locale === 'vi' ? `huong-dan-${slug}.md` : `setup-guide-${slug}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (loadError) return <ErrorState error={loadError} onRetry={() => void load()} />;
  if (!summary) return <Loading />;

  const stepTitle = step === 1 ? t('ui.setup.step_domain') : step === 2 ? t('ui.setup.step_hosting') : step === packageStep ? t('ui.setup.step_package') : t('ui.setup.step_connection');
  const canNext = step === 1
    ? domain !== null && (domain !== 'subdomain' || subCheck?.available === true)
    : step === 2
      ? hosting !== null
      : true;

  const domainPart = domain === 'own' ? t('ui.setup.sum_domain_own') : domain === 'subdomain' ? t('ui.setup.sum_domain_sub', { host: subdomainHostname }) : t('ui.setup.sum_domain_free');
  const hostingPart = hosting === 'vps' ? t('ui.setup.sum_hosting_vps') : t('ui.setup.sum_hosting_free');
  const variantPart = variant === 'demo' ? t('ui.setup.sum_variant_demo') : t('ui.setup.sum_variant_clean');

  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>{t('ui.setup.title')}</h2>
      <p className="muted" style={{ margin: 0 }}>{t('ui.setup.lead')}</p>
      <h3 style={{ margin: 0 }}>{t('ui.setup.step_label', { n: String(step) })}: {stepTitle}</h3>

      {step === 1 ? (
        <fieldset>
          <legend className="visually-hidden">{t('ui.setup.step_domain')}</legend>
          <div className="stack">
            <label className="row">
              <input type="radio" name="setup-domain" checked={domain === 'own'} onChange={() => setDomain('own')} />
              <span><strong>{t('ui.setup.domain_own')}</strong><br /><span className="muted">{t('ui.setup.domain_own_note')}</span></span>
            </label>
            {domain === 'own' ? (
              <label>{t('ui.setup.domain_own_input')}<br />
                <input className="input" type="text" value={ownHostname} onChange={(e) => setOwnHostname(e.target.value)} placeholder="example.com" />
              </label>
            ) : null}
            <label className="row">
              <input type="radio" name="setup-domain" checked={domain === 'subdomain'} onChange={() => { setDomain('subdomain'); setSubCheck(null); }} />
              <span><strong>{t('ui.setup.domain_sub')}</strong><br /><span className="muted">{t('ui.setup.domain_sub_note')}</span></span>
            </label>
            {domain === 'subdomain' ? (
              <div className="stack">
                <label>{t('ui.setup.subdomain_label')}<br />
                  <span className="row">
                    <input className="input" type="text" value={subLabel} onChange={(e) => { setSubLabel(e.target.value); setSubCheck(null); }} placeholder="ten-cua-ban" />
                    <button type="button" className="button button--secondary" disabled={subBusy || !subLabel.trim()} onClick={() => void checkSubdomain()}>{subBusy ? t('ui.state.saving') : t('ui.setup.subdomain_check')}</button>
                  </span>
                </label>
                {subdomainHostname ? <p className="muted mono" style={{ margin: 0 }}>{subdomainHostname}</p> : null}
                {subError ? <ErrorState error={subError} /> : null}
                {subCheck ? (
                  <p style={{ margin: 0 }}>
                    {subCheck.available
                      ? t('ui.setup.subdomain_available')
                      : subCheck.reason === 'taken'
                        ? t('ui.setup.subdomain_taken')
                        : subCheck.reason === 'reserved'
                          ? t('ui.setup.subdomain_reserved')
                          : t('ui.setup.subdomain_invalid')}
                  </p>
                ) : null}
                <p className="muted" style={{ margin: 0 }}>{feeNote}</p>
              </div>
            ) : null}
            <label className="row">
              <input type="radio" name="setup-domain" checked={domain === 'free'} onChange={() => setDomain('free')} />
              <span><strong>{t('ui.setup.domain_free')}</strong><br /><span className="muted">{t('ui.setup.domain_free_note')}</span></span>
            </label>
          </div>
        </fieldset>
      ) : null}

      {step === 2 ? (
        <fieldset>
          <legend className="visually-hidden">{t('ui.setup.step_hosting')}</legend>
          <div className="stack">
            <label className="row">
              <input type="radio" name="setup-hosting" checked={hosting === 'vps'} onChange={() => setHosting('vps')} />
              <span><strong>{t('ui.setup.hosting_vps')}</strong><br /><span className="muted">{t('ui.setup.hosting_vps_note')}</span></span>
            </label>
            <label className="row">
              <input type="radio" name="setup-hosting" checked={hosting === 'free'} onChange={() => setHosting('free')} />
              <span><strong>{t('ui.setup.hosting_free')}</strong><br /><span className="muted">{t('ui.setup.hosting_free_note')}</span></span>
            </label>
            {hosting === 'free' ? (
              <div className="stack">
                <p style={{ margin: 0 }}><strong>{isStatic ? t('ui.setup.free_static') : t('ui.setup.free_runtime')}</strong></p>
                <p className="muted" style={{ margin: 0 }}>{isStatic ? t('ui.setup.free_static_body') : t('ui.setup.free_runtime_body')}</p>
                {!isStatic && sizeLabel ? <p className="muted" style={{ margin: 0 }}>{t('ui.setup.capacity_note', { size: sizeLabel })}</p> : null}
              </div>
            ) : null}
          </div>
        </fieldset>
      ) : null}

      {step === 3 && showConnection ? (
        <div className="stack">
          <p className="muted" style={{ margin: 0 }}>{t('ui.setup.connection_note')}</p>
          <p style={{ margin: 0 }}>{t('ui.setup.connection_guide')}</p>
          <label>{t('ui.setup.connection_hostname')}<br />
            <input className="input" type="text" value={connHostname} onChange={(e) => setConnHostname(e.target.value)} placeholder={derivedHostname} />
          </label>
          <label>{t('ui.setup.connection_ip')}<br />
            <input className="input" type="text" value={connIp} onChange={(e) => setConnIp(e.target.value)} placeholder="203.0.113.10" />
          </label>
          <div className="row">
            <button type="button" className="button button--secondary" disabled={connBusy || !(connHostname.trim() || derivedHostname)} onClick={() => void checkConnection()}>{connBusy ? t('ui.state.saving') : t('ui.setup.connection_check')}</button>
          </div>
          {connError ? <ErrorState error={connError} /> : null}
          {connResult ? (
            <div className="stack">
              <p style={{ margin: 0 }}>
                {connResult.private
                  ? t('ui.setup.connection_private')
                  : connResult.dns_ok
                    ? t('ui.setup.connection_dns_ok', { count: String(connResult.addresses) })
                    : t('ui.setup.connection_dns_fail')}
              </p>
              <p style={{ margin: 0 }}>
                {connResult.http_ok
                  ? t('ui.setup.connection_http_ok', { status: String(connResult.http_status) })
                  : t('ui.setup.connection_http_fail')}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      {step === packageStep ? (
        <div className="stack">
          <p style={{ margin: 0 }}>{t('ui.setup.package_summary', { summary: `${domainPart}, ${hostingPart}, ${variantPart}` })}</p>
          <fieldset>
            <legend className="visually-hidden">{t('ui.setup.step_package')}</legend>
            <div className="row">
              <label className="row">
                <input type="radio" name="setup-variant" checked={variant === 'demo'} onChange={() => setVariant('demo')} />
                <span>{t('ui.setup.variant_demo')}</span>
              </label>
              <label className="row">
                <input type="radio" name="setup-variant" checked={variant === 'clean'} onChange={() => setVariant('clean')} />
                <span>{t('ui.setup.variant_clean')}</span>
              </label>
            </div>
          </fieldset>
          <div className="row">
            <button type="button" className="button" onClick={downloadGuide}>{t('ui.setup.package_guide')}</button>
          </div>
          <p className="muted" style={{ margin: 0 }}>{t('ui.setup.package_hint')}</p>
        </div>
      ) : null}

      <div className="row">
        {step > 1 ? <button type="button" className="button button--secondary" onClick={() => setStep(step - 1)}>{t('ui.setup.back')}</button> : null}
        {step < packageStep ? <button type="button" className="button" disabled={!canNext} onClick={() => setStep(step + 1)}>{t('ui.setup.next')}</button> : null}
      </div>
    </div>
  );
}
