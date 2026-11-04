import { RequirePermission } from '@/components/dashboard-shell';
import { MailForm } from '../forms';

export default function MailSettingsPage() {
  return (
    <RequirePermission permission="settings:manage">
      <MailForm />
    </RequirePermission>
  );
}
