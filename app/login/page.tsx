import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/auth/LoginForm";
import { LogoMark } from "@/components/LogoMark";
import { Notice } from "@/components/ui";
import { isSignedIn } from "@/lib/auth/server";
import { currentAccessConfig, safeNextPath } from "@/lib/auth/session";

export const metadata: Metadata = {
  title: "Sign in · EventLens",
  robots: { index: false, follow: false },
};

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { next: raw } = await searchParams;
  const next = safeNextPath(Array.isArray(raw) ? raw[0] : raw);
  // Also true while the gate is off.
  if (await isSignedIn()) redirect(next);
  const config = currentAccessConfig();

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-4 py-10">
      <div className="rounded-xl border border-border bg-surface p-5 sm:p-6">
        <h1 className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight">
          <LogoMark />
          EventLens
        </h1>
        <p className="mt-1 text-sm text-ink-secondary">EventLens is private. Enter the access password to continue.</p>
        {config.mode === "misconfigured" ? (
          <div className="mt-5">
            <Notice
              title="Sign-in isn't set up"
              message="This server is missing its access settings, so nobody can sign in yet. The server log says what to fix."
            />
          </div>
        ) : (
          <LoginForm next={next} />
        )}
      </div>
    </main>
  );
}
