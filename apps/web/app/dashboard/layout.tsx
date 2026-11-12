import { UserButton } from '@clerk/nextjs';
import { DashboardShell } from '@/components/app/shell';
import { CLERK_ENABLED } from '@/lib/env';

export const metadata = { title: { default: 'Dashboard', template: '%s | Sentra' } };

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <DashboardShell clerk={CLERK_ENABLED} userSlot={CLERK_ENABLED ? <UserButton /> : undefined}>
      {children}
    </DashboardShell>
  );
}
