import { SignUp } from '@clerk/nextjs';
import { AuthDisabled } from '@/components/app/auth-disabled';
import { CLERK_ENABLED } from '@/lib/env';

export const metadata = { title: 'Sign up' };

export default function Page() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      {CLERK_ENABLED ? <SignUp /> : <AuthDisabled mode="up" />}
    </main>
  );
}
