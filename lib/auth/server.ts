import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  createSessionToken,
  currentAccessConfig,
  hasValidSession,
  LOGIN_PATH,
  SESSION_MAX_AGE_SEC,
  sessionCookie,
  type AccessOn,
} from "./session";

/** True for everyone while the gate is off. */
export async function isSignedIn(): Promise<boolean> {
  // Reading cookies first makes the page dynamic before the config is read, so builds don't log
  // the missing env vars that only the running server needs.
  const jar = await cookies();
  return hasValidSession(currentAccessConfig(), jar);
}

/**
 * For pages: renders only for a signed-in visitor and sends anyone else to sign in. The proxy
 * already did this; checking again keeps the page safe if the proxy's matcher ever misses it.
 */
export async function requirePageSession(): Promise<void> {
  if (!(await isSignedIn())) redirect(LOGIN_PATH);
}

/** Whether there's anything to sign out of: false only under `next dev` without a password. */
export function isAccessGateOn(): boolean {
  return currentAccessConfig().mode !== "off";
}

export async function startSession(config: AccessOn): Promise<void> {
  const { name, secure } = config.cookie;
  (await cookies()).set(name, await createSessionToken(config), {
    httpOnly: true,
    secure,
    // Lax still sends the cookie when someone opens a shared analysis link from another site.
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SEC,
  });
}

export async function endSession(): Promise<void> {
  // Browsers ignore a __Host- cookie's deletion unless it repeats Secure and Path=/.
  const { name, secure } = sessionCookie();
  (await cookies()).delete({ name, httpOnly: true, secure, sameSite: "lax", path: "/" });
}
