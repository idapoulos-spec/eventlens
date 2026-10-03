import { signOut } from "@/app/login/actions";

export function SignOutButton() {
  return (
    <form action={signOut} className="shrink-0">
      <button
        type="submit"
        className="inline-flex h-9 items-center justify-center rounded-lg border border-border px-3 text-sm font-medium text-ink-secondary transition hover:bg-surface-raised hover:text-ink"
      >
        Sign out
      </button>
    </form>
  );
}
