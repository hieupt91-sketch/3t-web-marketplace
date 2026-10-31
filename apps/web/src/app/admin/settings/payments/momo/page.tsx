import { RequirePermission } from '@/components/dashboard-shell';
import { MoMoForm, PaymentSettingsBackLink } from '../forms';

export default function MoMoPaymentSettingsPage() {
  return (
    <RequirePermission permission="settings:manage">
      <div className="stack">
        <PaymentSettingsBackLink />
        <MoMoForm />
      </div>
    </RequirePermission>
  );
}
