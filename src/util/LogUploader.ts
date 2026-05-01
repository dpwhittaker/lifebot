import type { LogEntry } from '../ui/OrchestratorLog';

// Default endpoint is relative — works whether served from /lifebot/ on the
// tailnet or from `vite dev` on a port. Override via VITE_LIFEBOT_LOG_URL.
const ENDPOINT =
  (import.meta.env.VITE_LIFEBOT_LOG_URL as string | undefined) ?? '/lifebot/logs';
const FLUSH_INTERVAL_MS = 5000;
const MAX_BATCH = 100;
const MAX_QUEUE = 500;

export class LogUploader {
  private queue: LogEntry[] = [];
  private flushing = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  enqueue(entry: LogEntry) {
    this.queue.push(entry);
    if (this.queue.length > MAX_QUEUE) {
      this.queue.splice(0, this.queue.length - MAX_QUEUE);
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async flush() {
    if (this.flushing) return;
    if (this.queue.length === 0) return;
    this.flushing = true;
    const batch = this.queue.slice(0, MAX_BATCH);
    const body = batch
      .map((e) =>
        JSON.stringify({
          id: e.id,
          at: new Date(e.at).toISOString(),
          kind: e.kind,
          text: e.text,
          meta: e.meta ?? null,
        }),
      )
      .join('\n');
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-ndjson' },
        body,
      });
      if (res.ok) {
        // Drop the items we just sent.
        this.queue.splice(0, batch.length);
      }
    } catch {
      // Network down or proxy unreachable — keep the batch and retry next tick.
    } finally {
      this.flushing = false;
    }
  }
}
