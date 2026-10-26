/** The site's disclaimer: under every page, and at the end of every report. */
export const DISCLAIMER = "Experimental market-research tool. Metrics are informational and are not investment recommendations.";

export function Disclaimer() {
  return <p className="text-xs text-ink-muted">{DISCLAIMER}</p>;
}
