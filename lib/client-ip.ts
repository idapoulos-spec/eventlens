/**
 * Best-effort client IP, used as the rate-limit key. On Vercel, x-real-ip and
 * x-forwarded-for are set by Vercel's network and overwrite anything the client
 * sends. Elsewhere they are only as trustworthy as the proxy in front of the app.
 */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return headers.get("x-real-ip") || forwarded || "unknown";
}
