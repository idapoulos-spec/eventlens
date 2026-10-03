"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { endSession, startSession } from "@/lib/auth/server";
import { currentAccessConfig, LOGIN_PATH, passwordMatches, safeNextPath } from "@/lib/auth/session";
import { clientIp } from "@/lib/client-ip";
import { formatWait } from "@/lib/format";
import { createRateLimiter } from "@/lib/rate-limit";

export type SignInState = { error: string } | null;

// Per IP and per server instance, like every limit in this app, so it slows guessing rather than
// capping it; a long password is what makes guessing hopeless. A Vercel Firewall rule on
// POST /login can add a limit shared by all instances (see README → Access).
const limiter = createRateLimiter([
  { windowMs: 60 * 1000, max: 5 },
  { windowMs: 60 * 60 * 1000, max: 20 },
]);

export async function signIn(_previous: SignInState, form: FormData): Promise<SignInState> {
  const next = form.get("next");
  const destination = safeNextPath(typeof next === "string" ? next : null);
  const config = currentAccessConfig();
  if (config.mode === "off") redirect(destination);
  if (config.mode === "misconfigured") return { error: "Sign-in isn't set up on this server yet." };

  const limit = limiter(clientIp(await headers()));
  if (!limit.ok) return { error: `Too many sign-in attempts. Try again in ${formatWait(limit.retryAfterSec)}.` };

  const password = form.get("password");
  if (typeof password !== "string" || !(await passwordMatches(config, password))) {
    return { error: "That password isn't right." };
  }
  await startSession(config);
  redirect(destination);
}

export async function signOut(): Promise<void> {
  await endSession();
  redirect(LOGIN_PATH);
}
