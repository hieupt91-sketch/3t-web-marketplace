import { RequirePermission } from '@/components/dashboard-shell';
import { BankTransferForm, PaymentSettingsBackLink } from '../forms';

export default function BankPaymentSettingsPage() {
  return (
    <RequirePermission permission="settings:manage">
      <div className="stack">
        <PaymentSettingsBackLink />
        <BankTransferForm />
      </div>
    </RequirePermission>
  );
}
