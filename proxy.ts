import { NextResponse, type NextRequest } from "next/server";
import { currentAccessConfig, hasValidSession, LOGIN_PATH, unauthorizedResponse } from "@/lib/auth/session";

/**
 * The access gate's first check: a request without a valid session never reaches a page or API
 * route. Pages and routes check again themselves (lib/auth), as Next.js recommends.
 */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  // The sign-in page and its action (a POST to the same path) are the only way in.
  if (pathname === LOGIN_PATH) return NextResponse.next();
  if (await hasValidSession(currentAccessConfig(), request.cookies)) return NextResponse.next();

  if (pathname === "/api" || pathname.startsWith("/api/")) return unauthorizedResponse();
  if (request.method === "GET" || request.method === "HEAD") {
    // Come back to the same page, e.g. a shared analysis link, after signing in.
    const login = new URL(LOGIN_PATH, request.url);
    if (pathname !== "/" || search) login.searchParams.set("next", pathname + search);
    return NextResponse.redirect(login);
  }
  return new Response("Sign in to use EventLens.", { status: 401, headers: { "Cache-Control": "no-store" } });
}

export const config = {
  // Every path except build assets, which hold no data, so pages and routes added later are covered too.
  matcher: ["/((?!_next/static/|favicon\\.ico$).*)"],
};
