import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { DashboardShell } from '@/components/dashboard-shell';

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function PartnerLayout({ children }: { children: ReactNode }) {
  return <DashboardShell area="partner">{children}</DashboardShell>;
}
