import { RequirePermission } from '@/components/dashboard-shell';
import { PayosForm, PaymentSettingsBackLink } from '../forms';

export default function PayosPaymentSettingsPage() {
  return (
    <RequirePermission permission="settings:manage">
      <div className="stack">
        <PaymentSettingsBackLink />
        <PayosForm />
      </div>
    </RequirePermission>
  );
}
