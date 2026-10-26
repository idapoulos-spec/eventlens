import type { Metadata } from "next";
import Link from "next/link";
import { SignOutButton } from "@/components/auth/SignOutButton";
import { Disclaimer } from "@/components/Disclaimer";
import { LogoMark } from "@/components/LogoMark";
import { StudiesPage } from "@/components/studies/StudiesPage";
import { isAccessGateOn, requirePageSession } from "@/lib/auth/server";

export const metadata: Metadata = { title: "Saved studies · EventLens" };

/** This browser's saved studies. The server renders only the page around them: the list lives in localStorage. */
export default async function Studies() {
  await requirePageSession();
  return (
    <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8 lg:py-10">
      <header className="mb-5 flex items-start justify-between gap-4 sm:mb-6">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight">
            <Link href="/" className="flex items-center gap-2.5">
              <LogoMark />
              EventLens
            </Link>
          </h1>
          <p className="mt-1 text-sm text-ink-secondary">Saved studies: analyses and scans to come back to, with your notes.</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Link href="/scan" className="text-sm text-ink-secondary hover:text-ink">
            Scan many events
          </Link>
          {isAccessGateOn() && <SignOutButton />}
        </div>
      </header>
      <StudiesPage />
      <footer className="mt-10 border-t border-border pt-4">
        <Disclaimer />
      </footer>
    </div>
  );
}
