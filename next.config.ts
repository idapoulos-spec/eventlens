import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { NextConfig } from "next";

/** package.json's version, bumped before each release is tagged (AGENTS.md). */
const version = (JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string }).version;

/** The commit being built: Vercel's, else the checkout's, else "unknown" (a build outside git). */
function commit(): string {
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA;
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || "unknown";
  } catch {
    return "unknown";
  }
}

const nextConfig: NextConfig = {
  // The version and commit a report names (lib/report/version.ts), fixed at build time.
  env: { EVENTLENS_VERSION: version, EVENTLENS_COMMIT: commit() },
};

export default nextConfig;
