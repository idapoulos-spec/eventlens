"use client";

import { useActionState } from "react";
import { signIn, type SignInState } from "@/app/login/actions";
import { labelTextClass } from "@/components/search/field";

/** The access password, checked by the signIn action, which then goes to `next`. */
export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<SignInState, FormData>(signIn, null);

  return (
    <form action={action} className="mt-5">
      <input type="hidden" name="next" value={next} />
      <label htmlFor="password" className={labelTextClass}>
        Access password
      </label>
      {/* 16px text on phones keeps iOS Safari from zooming in when the field is focused. */}
      <input
        id="password"
        name="password"
        type="password"
        required
        autoFocus
        autoComplete="current-password"
        aria-invalid={state ? true : undefined}
        aria-describedby={state ? "password-error" : undefined}
        className="w-full rounded-lg border border-border bg-surface-raised px-3 py-2.5 text-base text-ink placeholder:text-ink-muted focus:border-series-kalshi focus:outline-none focus:ring-1 focus:ring-series-kalshi aria-invalid:border-down/60 sm:text-sm"
      />
      <p id="password-error" role="alert" className="mt-2 min-h-5 text-sm text-down">
        {state?.error}
      </p>
      <button
        type="submit"
        disabled={pending}
        className="mt-2 inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-series-kalshi px-5 text-sm font-semibold text-white transition hover:brightness-110 disabled:cursor-wait disabled:opacity-70 sm:h-10"
      >
        {pending && (
          <span
            aria-hidden
            className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/35 border-t-white motion-reduce:animate-none"
          />
        )}
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
