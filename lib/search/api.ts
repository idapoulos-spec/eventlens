// Request parsing and error responses shared by the search API routes.

import type { Validated } from "@/lib/validation";
import type { SearchErrorResponse } from "./types";

/** Query-string parameter both routes read, e.g. /api/search/stocks?q=nvidia. */
export const SEARCH_QUERY_PARAM = "q";

/** Long enough to paste a full Kalshi market ticker (up to 100 characters). */
export const MAX_SEARCH_QUERY_LENGTH = 100;

const CONTROL_CHAR = /\p{Cc}/u;

/** Trims and collapses whitespace, so "  fed   hike " and "fed hike" are the same query. */
export function validateSearchQuery(input: string | null | undefined): Validated {
  const value = (input ?? "").trim().replace(/\s+/g, " ");
  if (!value) return { ok: false, message: "Enter something to search for." };
  // Count characters, not UTF-16 units, like the ticker validators.
  if (Array.from(value).length > MAX_SEARCH_QUERY_LENGTH) {
    return { ok: false, message: `Search for at most ${MAX_SEARCH_QUERY_LENGTH} characters.` };
  }
  if (CONTROL_CHAR.test(value)) return { ok: false, message: "The search contains characters that can't be searched." };
  return { ok: true, value };
}

export function searchError(status: number, code: string, message: string, headers?: HeadersInit): Response {
  const body: SearchErrorResponse = { error: { code, message } };
  return Response.json(body, { status, headers });
}
