"use client";

// Runs the Research panel's slower jobs (lib/analytics/panel-jobs.ts) after its main results have
// rendered: the longer windows, the detectable size, and the leave-one-out check. They run a slice
// at a time (one bootstrap or less, at most about 30 ms of work per task) and hand the main thread
// back in between, so clicks and scrolling stay responsive while they compute. Each part's result is
// kept by its key; asking for other jobs drops ones that are no longer wanted.
//
// A Web Worker would move them off the main thread entirely, but Next.js 16.3's Turbopack emits
// `new Worker(new URL(…, import.meta.url))` targets as plain static files rather than bundles, so
// the worker can't load its imports.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { panelRunner, type PanelJob, type PanelMessage } from "@/lib/analytics/panel-jobs";

/** A part's result is stored as `${kind}:${key}`. */
export const partId = (kind: PanelMessage["kind"], key: string) => `${kind}:${key}`;
const jobId = (job: PanelJob) => `${job.kind}:${job.key}`;
/** The part that finishes a job. */
const lastPart = (job: PanelJob) => partId(job.kind === "main" ? "main" : "leave_one_out", job.key);

/** Work done in one task before the page gets the main thread back (ms). */
const SLICE_MS = 30;
// Results kept for switching back to a window without recomputing it.
const KEEP = 40;
const EMPTY: ReadonlyMap<string, PanelMessage> = new Map();
const now = () => performance.now();

class PanelJobs {
  private run = panelRunner();
  private queue: { id: string; steps: Generator<PanelMessage | null, void> }[] = [];
  private results = new Map<string, PanelMessage>();
  private snapshot: ReadonlyMap<string, PanelMessage> = EMPTY;
  private listeners = new Set<() => void>();
  private scheduled = false;
  private channel: MessageChannel | null = null;
  /** The longest slice so far (ms): how long the page went without the main thread. */
  longestSlice = 0;

  request(jobs: PanelJob[]) {
    const wanted = jobs.filter((j) => !this.results.has(lastPart(j)));
    const ids = new Set(wanted.map(jobId));
    // Drop work no longer wanted; a partly run job's steps are simply discarded.
    this.queue = this.queue.filter((q) => ids.has(q.id));
    for (const job of wanted) {
      if (this.queue.some((q) => q.id === jobId(job))) continue;
      this.queue.push({ id: jobId(job), steps: this.run(job) });
    }
    this.schedule();
  }

  private schedule() {
    if (this.scheduled || this.queue.length === 0) return;
    this.scheduled = true;
    // A message, not setTimeout, so the slices aren't spaced out by timer clamping.
    if (!this.channel && typeof MessageChannel !== "undefined") {
      this.channel = new MessageChannel();
      this.channel.port1.onmessage = () => this.slice();
    }
    if (this.channel) this.channel.port2.postMessage(null);
    else setTimeout(() => this.slice(), 0);
  }

  private slice() {
    this.scheduled = false;
    const start = now();
    while (this.queue.length > 0 && now() - start < SLICE_MS) {
      const job = this.queue[0];
      const step = job.steps.next();
      if (step.done) {
        this.queue.shift();
        continue;
      }
      if (step.value) this.receive(step.value);
    }
    const ms = now() - start;
    this.longestSlice = Math.max(this.longestSlice, ms);
    try {
      performance.measure("research:slice", { start, duration: ms });
    } catch {
      // Older browsers: no timing marks.
    }
    this.schedule();
  }

  private receive(message: PanelMessage) {
    const id = partId(message.kind, message.key);
    this.results.delete(id);
    this.results.set(id, message);
    while (this.results.size > KEEP) this.results.delete(this.results.keys().next().value!);
    try {
      performance.measure(`research:${message.kind}`, { start: now() - message.ms, duration: message.ms });
    } catch {
      // Older browsers: no timing marks.
    }
    this.snapshot = new Map(this.results);
    for (const listener of this.listeners) listener();
  }

  dispose() {
    this.queue = [];
    this.channel?.port1.close();
    this.channel = null;
    this.listeners.clear();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;
}

/** Requests `jobs` (by key, so results already in hand aren't recomputed) and returns every part's latest result. */
export function usePanelJobs(jobs: PanelJob[]): ReadonlyMap<string, PanelMessage> {
  const [client] = useState(() => new PanelJobs());
  useEffect(() => () => client.dispose(), [client]);
  const latest = useRef(jobs);
  useEffect(() => {
    latest.current = jobs;
  });
  const signature = jobs.map(jobId).join("|");
  useEffect(() => {
    client.request(latest.current);
  }, [client, signature]);
  return useSyncExternalStore(client.subscribe, client.getSnapshot, () => EMPTY);
}

/** True once the same `pendingKey` has been pending for `ms`, so a quick result doesn't flash a placeholder. Null: nothing pending. */
export function useDelayed(pendingKey: string | null, ms = 150): boolean {
  const [shownFor, setShownFor] = useState<string | null>(null);
  useEffect(() => {
    if (pendingKey === null) return;
    const timer = setTimeout(() => setShownFor(pendingKey), ms);
    return () => clearTimeout(timer);
  }, [pendingKey, ms]);
  return pendingKey !== null && shownFor === pendingKey;
}
