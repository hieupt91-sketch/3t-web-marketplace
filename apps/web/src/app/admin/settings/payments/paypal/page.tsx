import { RequirePermission } from '@/components/dashboard-shell';
import { PayPalForm, PaymentSettingsBackLink } from '../forms';

export default function PayPalPaymentSettingsPage() {
  return (
    <RequirePermission permission="settings:manage">
      <div className="stack">
        <PaymentSettingsBackLink />
        <PayPalForm />
      </div>
    </RequirePermission>
  );
}
