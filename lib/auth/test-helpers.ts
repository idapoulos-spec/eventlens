// For tests only: turns the access gate on, as in production, and signs a visitor in.

import { vi } from "vitest";
import { createSessionToken, readAccessConfig, type AccessOn } from "./session";

export const TEST_PASSWORD = "correct horse battery staple";
export const TEST_SECRET = "a-test-secret-that-is-at-least-32-characters";

/** Sets ACCESS_PASSWORD and AUTH_SECRET until vi.unstubAllEnvs(). */
export function stubAccessEnv(): AccessOn {
  vi.stubEnv("ACCESS_PASSWORD", TEST_PASSWORD);
  vi.stubEnv("AUTH_SECRET", TEST_SECRET);
  const config = readAccessConfig();
  if (config.mode !== "on") throw new Error(`Access gate isn't on in tests: ${JSON.stringify(config)}`);
  return config;
}

/** A Cookie header for a signed-in visitor, with the gate on. */
export async function signedInCookie(): Promise<string> {
  const config = stubAccessEnv();
  return `${config.cookie.name}=${await createSessionToken(config)}`;
}
