'use client';

import { useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorState, Loading } from '@/components/ui';
import { api, type ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
export default function PartnerDevelopers() {
  const { t } = useT();
  return (
    <div className="stack">
      <h1>{t('ui.partner.developers')}</h1>
      <p>POST /partner/v1/checkout-sessions with a Bearer key and an Idempotency-Key. The key identifies the partner; the body must never set partner_id, totals, or is_paid — the platform prices server-side.</p>
      <p>Webhook events are signed: X-3T-Signature v1=HMAC-SHA256(timestamp + '.' + raw body). Verify in constant time, allow 5 minutes of clock skew, and dedupe by event id.</p>
      <p>Sandbox and production keys are separate. Never expose a key in browser code — call the Partner API from your backend.</p>
    </div>
  );
}
