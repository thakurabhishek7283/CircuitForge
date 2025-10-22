// User ops to the server (LLD §10 Sync): every change the core accepted becomes consecutive
// envelopes (one rev each, as the op log stores them), batched to `POST /v1/projects/{id}/ops` a
// second after the last change. Unsent ops are kept in IndexedDB; while the server cannot be
// reached they are retried with backoff and editing goes on locally (LLD §14). A `stale_rev`, a
// running job or a refused op means this editor and the server disagree: the project is reloaded.
import type { OpEnvelope } from "../gen/contract.ts";
import { type ApiClient, ApiFailure, isOffline } from "../api/client.ts";
import type { CircuitStore, Committed } from "./circuitStore.ts";
import type { PendingStore } from "./pending.ts";

export interface SyncStatus {
  state: "saved" | "saving" | "offline" | "stale";
  /** Ops the server does not have yet. */
  unsent: number;
}

export interface SyncOptions {
  store: CircuitStore;
  api: Pick<ApiClient, "appendOps">;
  project: string;
  pending: PendingStore;
  /** The server's head rev when the editor opened (pending ops replayed on top of it). */
  serverRev: number;
  /** Ops replayed from IndexedDB at open, still to be sent. */
  unsent?: OpEnvelope[];
  /** The server and this editor disagree: reload the project. */
  onStale: (e: ApiFailure) => void;
  onStatus?: (s: SyncStatus) => void;
  intervalMs?: number;
  maxBatch?: number;
  retryMs?: number[];
}

export const SYNC_INTERVAL_MS = 1000;
const RETRY_MS = [1000, 2000, 5000, 10_000, 30_000];

export function toEnvelopes(c: Committed): OpEnvelope[] {
  return c.ops.map((op, i) => ({ v: 1, seq: c.baseRev + i + 1, ...op, author: c.author, base_rev: c.baseRev + i }) as OpEnvelope);
}

export class Sync {
  private serverRev: number;
  private queue: OpEnvelope[];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sending: Promise<void> | null = null;
  private failures = 0;
  private stale = false;
  private disposed = false;
  private readonly unsubscribe: () => void;
  private readonly onOnline = () => this.schedule(0);
  private readonly opts: SyncOptions;

  constructor(opts: SyncOptions) {
    this.opts = opts;
    this.serverRev = opts.serverRev;
    this.queue = [...(opts.unsent ?? [])];
    this.unsubscribe = opts.store.getState().onCommit((c) => this.committed(c));
    globalThis.addEventListener?.("online", this.onOnline);
    this.status();
    if (this.queue.length) this.schedule(0);
  }

  /** The rev the server has confirmed. */
  get confirmedRev(): number {
    return this.serverRev;
  }

  get unsent(): number {
    return this.queue.length;
  }

  /** The server moved on by itself (a generation job's commits); only valid with nothing unsent. */
  advance(rev: number): void {
    if (this.queue.length) throw new Error("advance with unsent ops");
    this.serverRev = rev;
  }

  /** Send everything now (before a generation job reads the project). Rejects while offline. */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    while (this.queue.length && !this.disposed) {
      await (this.sending ??= this.send().finally(() => (this.sending = null)));
      if (this.stale) throw new ApiFailure(409, { code: "stale_rev", message: "the project changed on the server" });
      if (this.failures) throw new ApiFailure(0, { code: "offline", message: "the server cannot be reached", retryable: true });
    }
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.unsubscribe();
    globalThis.removeEventListener?.("online", this.onOnline);
  }

  private committed(c: Committed): void {
    if (this.stale) return;
    const expected = this.serverRev + this.queue.length;
    if (c.baseRev !== expected) {
      // An op applied that sync never saw: the circuit is no longer the server's plus the queue.
      this.markStale(new ApiFailure(409, { code: "stale_rev", message: `local rev ${c.baseRev}, expected ${expected}` }));
      return;
    }
    this.queue.push(...toEnvelopes(c));
    void this.persist();
    this.status();
    this.schedule(this.opts.intervalMs ?? SYNC_INTERVAL_MS);
  }

  private schedule(ms: number): void {
    if (this.disposed || this.stale || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.sending) this.sending = this.send().finally(() => (this.sending = null));
    }, ms);
  }

  private async send(): Promise<void> {
    const max = this.opts.maxBatch ?? 500;
    while (this.queue.length && !this.disposed && !this.stale) {
      const batch = this.queue.slice(0, max);
      this.emit("saving");
      try {
        const { rev } = await this.opts.api.appendOps(this.opts.project, { base_rev: this.serverRev, ops: batch });
        this.queue.splice(0, batch.length);
        this.serverRev = rev;
        this.failures = 0;
        await this.persist();
      } catch (e) {
        if (isOffline(e) || (e instanceof ApiFailure && e.retryable)) {
          this.failures++;
          this.status();
          const retry = this.opts.retryMs ?? RETRY_MS;
          this.schedule(retry[Math.min(this.failures - 1, retry.length - 1)]!);
          return;
        }
        this.markStale(e instanceof ApiFailure ? e : new ApiFailure(0, { code: "internal", message: String(e) }));
        return;
      }
    }
    this.status();
  }

  private markStale(e: ApiFailure): void {
    this.stale = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    // The reload reads the server's circuit; ops it refused cannot be replayed onto it.
    this.queue = [];
    void this.persist();
    this.emit("stale");
    this.opts.onStale(e);
  }

  private persist(): Promise<void> {
    return this.opts.pending.put(this.opts.project, { baseRev: this.serverRev, envelopes: this.queue });
  }

  private status(): void {
    this.emit(this.stale ? "stale" : this.failures ? "offline" : this.queue.length ? "saving" : "saved");
  }

  private emit(state: SyncStatus["state"]): void {
    this.opts.onStatus?.({ state, unsent: this.queue.length });
  }
}
