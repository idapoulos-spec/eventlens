import type { ReactNode } from "react";

export function Card({
  title,
  subtitle,
  action,
  children,
  className = "",
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-xl border border-border bg-surface p-5 ${className}`}>
      {(title || action) && (
        <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold tracking-wide text-ink">{title}</h2>}
            {subtitle && <p className="mt-1 text-xs text-ink-muted">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  detail,
  size = "md",
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  size?: "md" | "lg";
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wider text-ink-muted">{label}</dt>
      <dd className={`mt-1 font-semibold text-ink ${size === "lg" ? "text-3xl" : "text-lg"}`}>{value}</dd>
      {detail && <dd className="mt-0.5 text-xs text-ink-secondary">{detail}</dd>}
    </div>
  );
}

/** Signed change with an arrow, so direction never relies on color alone. */
export function Delta({ value, formatted }: { value: number | null; formatted: string }) {
  if (value === null) return <span className="text-ink-muted">{formatted}</span>;
  const tone = value > 0 ? "text-up" : value < 0 ? "text-down" : "text-ink-secondary";
  const arrow = value > 0 ? "▲" : value < 0 ? "▼" : "■";
  return (
    <span className={`inline-flex items-center gap-1 ${tone}`}>
      <span aria-hidden className="text-[0.7em]">
        {arrow}
      </span>
      {formatted}
    </span>
  );
}

export function Notice({
  title,
  message,
  tone = "error",
}: {
  title: string;
  message: string;
  tone?: "error" | "info";
}) {
  const accent = tone === "error" ? "border-down/40" : "border-warn/40";
  const icon = tone === "error" ? "!" : "i";
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`flex gap-3 rounded-lg border ${accent} bg-surface-raised p-4`}>
      <span
        aria-hidden
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold text-page ${
          tone === "error" ? "bg-down" : "bg-warn"
        }`}
      >
        {icon}
      </span>
      <div className="min-w-0 text-sm">
        <p className="font-medium text-ink">{title}</p>
        <p className="mt-1 text-ink-secondary">{message}</p>
      </div>
    </div>
  );
}
