'use client';

import { formatMoney, type Locale } from '@3t/i18n';
import { useT } from '@/lib/i18n';

export interface QuoteLike {
  currency: string;
  subtotal_minor: string;
  discount_minor: string;
  tax_minor: string;
  total_minor: string;
  line_items: { label: string; interval: string; amount_minor: string }[];
}

/** PriceBreakdown for checkout: each line, then subtotal/discount/tax/total (docs/05 B01-B04). */
export function MoneyLines({ quote, locale }: { quote: QuoteLike; locale: Locale }) {
  const { t } = useT();
  const m = (amount: string) => formatMoney({ amount_minor: amount, currency: quote.currency }, locale);
  const lineLabel = (interval: string) => (interval === 'one_time' ? t('ui.price.one_time') : t(`ui.price.${interval}`));
  return (
    <dl className="details">
      {quote.line_items.map((line, i) => (
        <div key={i} style={{ display: 'contents' }}>
          <dt>{lineLabel(line.interval)}</dt>
          <dd className="tabular">{m(line.amount_minor)}</dd>
        </div>
      ))}
      {quote.discount_minor !== '0' ? <><dt>{t('ui.checkout.discount')}</dt><dd className="tabular">−{m(quote.discount_minor)}</dd></> : null}
      {quote.tax_minor !== '0' ? <><dt>{t('ui.checkout.tax')}</dt><dd className="tabular">{m(quote.tax_minor)}</dd></> : null}
      <dt><strong>{t('ui.checkout.total')}</strong></dt>
      <dd className="tabular"><strong>{m(quote.total_minor)}</strong></dd>
    </dl>
  );
}
