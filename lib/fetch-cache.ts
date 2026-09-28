// fetch() cache policies for third-party API requests.

/** Current quotes: always fetched fresh, never served from Next.js's data cache. */
export const LIVE: RequestInit = { cache: "no-store" };

/** Historical data and metadata: cached, refreshed after `seconds`. */
export const cachedFor = (seconds: number): RequestInit => ({ next: { revalidate: seconds } });
