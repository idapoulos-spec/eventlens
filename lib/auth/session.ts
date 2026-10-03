// The access gate: the shared password, signed session cookies, and the checks that the proxy,
// the pages, the API routes, and the sign-in action share. Web Crypto only and no Next.js
// imports, so the same code runs in the proxy, on the server, and in tests. Never import it
// from client code: it reads the secrets from process.env.

import type { DataError } from "@/lib/result";

export const LOGIN_PATH = "/login";

/** How long a sign-in lasts. Fixed from sign-in; visiting doesn't extend it. */
export const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60;

export const MIN_PASSWORD_LENGTH = 12;
export const MIN_SECRET_LENGTH = 32;
/** Longer input is rejected without being compared. */
export const MAX_PASSWORD_LENGTH = 256;

export const UNAUTHORIZED_MESSAGE = "Your session has ended. Reload the page to sign in again.";

export interface SessionCookie {
  name: string;
  secure: boolean;
}

export type AccessConfig =
  /** Only under `next dev` with no ACCESS_PASSWORD: everything is open. */
  | { mode: "off" }
  /** Fails closed: nobody can sign in until the env vars are fixed. */
  | { mode: "misconfigured"; problem: string }
  | { mode: "on"; password: string; secret: string; cookie: SessionCookie };

export type AccessOn = Extract<AccessConfig, { mode: "on" }>;

type Env = Record<string, string | undefined>;

/**
 * The __Host- prefix makes browsers require Secure and Path=/ and refuse a Domain, so no other
 * site or subdomain can set it. `next dev` serves plain http, where Safari drops Secure cookies
 * even on 127.0.0.1, so it gets an unprefixed, non-Secure cookie instead.
 */
export function sessionCookie(env: Env = process.env): SessionCookie {
  return env.NODE_ENV === "development"
    ? { name: "eventlens-session", secure: false }
    : { name: "__Host-eventlens-session", secure: true };
}

/** The gate's settings from the environment. Anything other than `next dev` requires both vars. */
export function readAccessConfig(env: Env = process.env): AccessConfig {
  const password = env.ACCESS_PASSWORD ?? "";
  const secret = env.AUTH_SECRET ?? "";
  if (!password && env.NODE_ENV === "development") return { mode: "off" };

  if (!password) return { mode: "misconfigured", problem: "ACCESS_PASSWORD isn't set" };
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { mode: "misconfigured", problem: `ACCESS_PASSWORD is shorter than ${MIN_PASSWORD_LENGTH} characters` };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { mode: "misconfigured", problem: `ACCESS_PASSWORD is longer than ${MAX_PASSWORD_LENGTH} characters` };
  }
  if (!secret) return { mode: "misconfigured", problem: "AUTH_SECRET isn't set" };
  if (secret.length < MIN_SECRET_LENGTH) {
    return { mode: "misconfigured", problem: `AUTH_SECRET is shorter than ${MIN_SECRET_LENGTH} characters` };
  }
  return { mode: "on", password, secret, cookie: sessionCookie(env) };
}

const logged = new Set<string>();

/** readAccessConfig for this server, logging once per server instance when the gate is off or broken. */
export function currentAccessConfig(): AccessConfig {
  const config = readAccessConfig();
  const note =
    config.mode === "off"
      ? "[access] Sign-in is off because ACCESS_PASSWORD isn't set (next dev only). To try it, set ACCESS_PASSWORD and AUTH_SECRET in .env.local."
      : config.mode === "misconfigured"
        ? `[access] Nobody can sign in: ${config.problem}. Every page redirects to ${LOGIN_PATH}. See README → Access.`
        : null;
  if (note && !logged.has(note)) {
    logged.add(note);
    if (config.mode === "off") console.warn(note);
    else console.error(note);
  }
  return config;
}

const encoder = new TextEncoder();

async function hmacKey(raw: BufferSource, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, usages);
}

let derived: { secret: string; password: string; key: Promise<CryptoKey> } | null = null;

/**
 * The key that signs sessions, derived from both env vars. Changing the password signs everyone
 * out, and a stolen cookie can't be used to guess the password offline without AUTH_SECRET.
 */
function sessionKey({ secret, password }: AccessOn): Promise<CryptoKey> {
  if (derived?.secret !== secret || derived.password !== password) {
    const key = hmacKey(encoder.encode(secret), ["sign"])
      .then((k) => crypto.subtle.sign("HMAC", k, encoder.encode(`eventlens session key\0${password}`)))
      .then((raw) => hmacKey(raw, ["sign", "verify"]));
    derived = { secret, password, key };
  }
  return derived.key;
}

function toBase64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}

/** `v1.<expiry in Unix seconds>.<HMAC-SHA256 of "v1.<expiry>">`. */
const TOKEN = /^v1\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/;

export async function createSessionToken(config: AccessOn, now: number = Date.now()): Promise<string> {
  const payload = `v1.${Math.floor(now / 1000) + SESSION_MAX_AGE_SEC}`;
  const signature = await crypto.subtle.sign("HMAC", await sessionKey(config), encoder.encode(payload));
  return `${payload}.${toBase64url(signature)}`;
}

export async function verifySessionToken(
  config: AccessOn,
  token: string | undefined,
  now: number = Date.now(),
): Promise<boolean> {
  const match = token ? TOKEN.exec(token) : null;
  if (!match) return false;
  const expires = Number(match[1]);
  const nowSec = now / 1000;
  // A later expiry than a new sign-in would get means the token is from before SESSION_MAX_AGE_SEC was shortened.
  if (expires <= nowSec || expires > nowSec + SESSION_MAX_AGE_SEC) return false;
  // crypto.subtle.verify compares in constant time.
  return crypto.subtle.verify("HMAC", await sessionKey(config), fromBase64url(match[2]), encoder.encode(`v1.${match[1]}`));
}

/** Compares MACs rather than the strings, so the time taken doesn't reveal how much of the input is right. */
export async function passwordMatches(config: AccessOn, input: string): Promise<boolean> {
  if (input.length > MAX_PASSWORD_LENGTH) return false;
  const key = await sessionKey(config);
  const expected = await crypto.subtle.sign("HMAC", key, encoder.encode(`password\0${config.password}`));
  return crypto.subtle.verify("HMAC", key, expected, encoder.encode(`password\0${input}`));
}

export interface CookieReader {
  get(name: string): { value: string } | undefined;
}

export async function hasValidSession(config: AccessConfig, cookies: CookieReader): Promise<boolean> {
  if (config.mode === "off") return true;
  if (config.mode === "misconfigured") return false;
  return verifySessionToken(config, cookies.get(config.cookie.name)?.value);
}

/** 401 in the API routes' error envelope. Never cached. */
export function unauthorizedResponse(): Response {
  const body: { error: DataError } = { error: { code: "unauthorized", message: UNAUTHORIZED_MESSAGE } };
  return Response.json(body, { status: 401, headers: { "Cache-Control": "no-store" } });
}

/** For API routes: a 401 response without a valid session, or null to carry on. */
export async function rejectUnlessSignedIn(cookies: CookieReader): Promise<Response | null> {
  return (await hasValidSession(currentAccessConfig(), cookies)) ? null : unauthorizedResponse();
}

const ORIGIN = "http://eventlens.invalid";

/**
 * Where to go after signing in: a path on this site, or "/". Anything that could leave the site
 * (`//host`, `/\host`, `https://…`) or loop back to the sign-in page becomes "/".
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/")) return "/";
  let url: URL;
  try {
    url = new URL(raw, ORIGIN);
  } catch {
    return "/";
  }
  const path = url.pathname + url.search + url.hash;
  if (url.origin !== ORIGIN || path.startsWith("//") || path.startsWith("/\\") || url.pathname === LOGIN_PATH) {
    return "/";
  }
  return path;
}
