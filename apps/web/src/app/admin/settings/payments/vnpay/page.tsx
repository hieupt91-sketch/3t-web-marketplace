import { RequirePermission } from '@/components/dashboard-shell';
import { PaymentSettingsBackLink, VnPayForm } from '../forms';

export default function VnPayPaymentSettingsPage() {
  return (
    <RequirePermission permission="settings:manage">
      <div className="stack">
        <PaymentSettingsBackLink />
        <VnPayForm />
      </div>
    </RequirePermission>
  );
}
