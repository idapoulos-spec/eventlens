import type { Metadata } from "next";
import Link from "next/link";
import { SignOutButton } from "@/components/auth/SignOutButton";
import { Disclaimer } from "@/components/Disclaimer";
import { LogoMark } from "@/components/LogoMark";
import { ScanPage } from "@/components/scan/ScanPage";
import { isAccessGateOn, requirePageSession } from "@/lib/auth/server";
import { parseScanLink } from "@/components/scan/link";
import { Notice } from "@/components/ui";

export const metadata: Metadata = { title: "Scan · EventLens" };

/** Every setting of the form, from the link (a saved or frozen scan's); nothing runs until asked. */
function readLink(params: Awaited<PageProps<"/scan">["searchParams"]>) {
  return parseScanLink((name) => {
    const v = params[name];
    return Array.isArray(v) ? v[0] : v;
  }, Date.now());
}

/**
 * One stock against many Kalshi events at once. The page itself loads nothing: the browser asks
 * the scan's routes for the candidates, the prices (once), and each candidate's Kalshi history.
 */
export default async function Scan({ searchParams }: PageProps<"/scan">) {
  await requirePageSession();
  const { link, asOf } = readLink(await searchParams);

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
          <p className="mt-1 text-sm text-ink-secondary">Scan: exploratory leads across many Kalshi events, corrected for testing them all.</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Link href="/studies" className="text-sm text-ink-secondary hover:text-ink">
            Saved studies
          </Link>
          {isAccessGateOn() && <SignOutButton />}
        </div>
      </header>
      {asOf.ok ? <ScanPage initial={link} /> : <Notice title="Invalid input" message={asOf.error.message} />}
      <footer className="mt-10 border-t border-border pt-4">
        <Disclaimer />
      </footer>
    </div>
  );
}
