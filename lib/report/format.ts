// Times as reports show them: New York time with the year and zone, and the UTC instant beside it
// where it identifies something exactly (an as-of time, the generation time).

import { formatDateTime } from "@/lib/format";

export const reportTime = (ms: number) => formatDateTime(ms, { withYear: true });

/** "Oct 7, 2026, 2:02 PM EDT (2026-10-07T18:02:10Z)". */
export const reportInstant = (ms: number) => `${reportTime(ms)} (${new Date(ms).toISOString().replace(".000Z", "Z")})`;

/** The footer's line naming the build. */
export const buildText = (version: string, commit: string) => `EventLens ${version === "unknown" ? "(version unknown)" : `v${version}`}, commit ${commit === "unknown" ? "unknown" : commit.slice(0, 12)}`;
