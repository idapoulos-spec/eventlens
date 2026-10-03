/** Two overlapping dots in the series colors: the Kalshi and stock lines on every chart. */
export function LogoMark() {
  return (
    <svg aria-hidden viewBox="0 0 24 16" className="h-4 w-6 shrink-0">
      <circle cx="8" cy="8" r="7" fill="var(--series-kalshi)" />
      <circle cx="16" cy="8" r="7" fill="var(--series-stock)" fillOpacity="0.85" />
    </svg>
  );
}
