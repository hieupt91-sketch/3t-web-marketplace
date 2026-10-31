import { RequirePermission } from '@/components/dashboard-shell';
import { PaymentSettingsBackLink, UsdForm } from '../forms';

export default function UsdPaymentSettingsPage() {
  return (
    <RequirePermission permission="settings:manage">
      <div className="stack">
        <PaymentSettingsBackLink />
        <UsdForm />
      </div>
    </RequirePermission>
  );
}
