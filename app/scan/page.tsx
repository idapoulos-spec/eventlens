import type { Metadata } from "next";
import Link from "next/link";
import { SignOutButton } from "@/components/auth/SignOutButton";
import { Disclaimer } from "@/components/Disclaimer";
import { LogoMark } from "@/components/LogoMark";
import { ScanPage } from "@/components/scan/ScanPage";
import { isAccessGateOn, requirePageSession } from "@/lib/auth/server";
import { validateStockTicker } from "@/lib/validation";

export const metadata: Metadata = { title: "Scan · EventLens" };

/**
 * One stock against many Kalshi events at once. The page itself loads nothing: the browser asks
 * the scan's routes for the candidates, the prices (once), and each candidate's Kalshi history.
 */
export default async function Scan({ searchParams }: PageProps<"/scan">) {
  await requirePageSession();
  const { stock: raw } = await searchParams;
  const stock = validateStockTicker(Array.isArray(raw) ? raw[0] : raw);

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
        {isAccessGateOn() && <SignOutButton />}
      </header>
      <ScanPage initialStock={stock.ok ? stock.value : ""} />
      <footer className="mt-10 border-t border-border pt-4">
        <Disclaimer />
      </footer>
    </div>
  );
}
