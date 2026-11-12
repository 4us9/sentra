import { SignIn } from '@clerk/nextjs';
import { AuthDisabled } from '@/components/app/auth-disabled';
import { CLERK_ENABLED } from '@/lib/env';

export const metadata = { title: 'Sign in' };

export default function Page() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      {CLERK_ENABLED ? <SignIn /> : <AuthDisabled mode="in" />}
    </main>
  );
}
