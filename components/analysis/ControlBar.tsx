import { Fragment, type ReactNode } from "react";

/** One control in a ControlBar: its button(s), and what it shows under the row. */
export interface Control {
  /** The control's button or buttons, in the bar's one row. */
  buttons: ReactNode;
  /** A short message: what it just did, or what it waits for. */
  status?: ReactNode;
  /** What it opened (a form), under the messages. */
  panel?: ReactNode;
}

/** A control's button, small and outlined, as every ControlBar's are. */
export const CONTROL_BUTTON =
  "inline-flex h-9 items-center rounded-md border border-border px-2.5 font-medium text-ink-secondary transition hover:bg-surface-raised hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 sm:h-7";

const present = (node: ReactNode) => node !== null && node !== undefined && node !== false;

/**
 * A line of text, then every control's buttons side by side in one group (which moves under the
 * text as a whole when the line is full, and wraps onto a second line on a narrow screen), then
 * the controls' messages, any notes, and whatever forms are open, in the controls' order.
 */
export function ControlBar({ lead, controls, notes }: { lead?: ReactNode; controls: Control[]; notes?: ReactNode }) {
  const statuses = controls.filter((c) => present(c.status));
  const panels = controls.filter((c) => present(c.panel));
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {lead}
        <div className="flex flex-wrap items-center gap-2">
          {controls.map((c, i) => (
            <Fragment key={i}>{c.buttons}</Fragment>
          ))}
        </div>
      </div>
      {statuses.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {statuses.map((c, i) => (
            <Fragment key={i}>{c.status}</Fragment>
          ))}
        </div>
      )}
      {notes}
      {panels.map((c, i) => (
        <Fragment key={i}>{c.panel}</Fragment>
      ))}
    </div>
  );
}
