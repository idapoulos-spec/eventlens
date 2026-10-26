// The app version and commit a report names: set at build time by next.config.ts, "unknown" elsewhere (tests).

export const APP_VERSION = process.env.EVENTLENS_VERSION ?? "unknown";
export const APP_COMMIT = process.env.EVENTLENS_COMMIT ?? "unknown";
