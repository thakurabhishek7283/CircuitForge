// A generation job's event stream (LLD §5): `GET /v1/jobs/{id}/events` over fetch with the bearer
// token, resumable. Every stored event carries its seq as the SSE `id`; a dropped or stalled
// connection reconnects with `Last-Event-ID` and the server replays what was missed from its Redis
// Stream, so nothing is lost or repeated. The stream ends with `done` or `error`.
import type { JobEvent } from "../gen/contract.ts";
import { ApiFailure } from "../api/client.ts";
import { SseParser } from "./sse.ts";

/** The server sends a heartbeat after 15 s without events; two missed ones and a margin mean the
 * connection is dead even if the socket has not noticed. */
export const STALL_MS = 35_000;
/** Reconnect delays, the last one repeated. */
export const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 10_000];

const EVENTS: ReadonlySet<string> = new Set([
  "job.state",
  "narration.delta",
  "block.ghost",
  "op",
  "block.repair",
  "sim.summary",
  "error",
  "done",
  "heartbeat",
]);

export type StreamStatus = "connecting" | "open" | "reconnecting";

export interface JobStreamOptions {
  url: string;
  headers: () => Promise<Record<string, string>>;
  /** Resume after this seq (0: from the start). */
  after?: number;
  onEvent: (event: JobEvent, seq: number | null) => void;
  onStatus?: (status: StreamStatus) => void;
  fetch?: typeof fetch;
  stallMs?: number;
  backoffMs?: number[];
  /** Waits between reconnects; replaced in tests. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface JobStream {
  /** Resolves after `done` or `error`; rejects when the stream cannot be read at all (401, 404). */
  finished: Promise<void>;
  /** The last seq received: where a reconnect resumes. */
  readonly lastSeq: number;
  close(): void;
}

const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });

class Stalled extends Error {}

export function openJobStream(opts: JobStreamOptions): JobStream {
  const fetchFn = opts.fetch ?? ((...args) => fetch(...args));
  const stallMs = opts.stallMs ?? STALL_MS;
  const backoff = opts.backoffMs ?? BACKOFF_MS;
  const sleep = opts.sleep ?? abortableSleep;
  const closed = new AbortController();
  let lastSeq = opts.after ?? 0;

  /** One connection: true when the stream reached its last event. */
  const connect = async (): Promise<boolean> => {
    const conn = new AbortController();
    const abort = () => conn.abort();
    closed.signal.addEventListener("abort", abort);
    let stall: ReturnType<typeof setTimeout> | undefined;
    const armStall = () => {
      clearTimeout(stall);
      stall = setTimeout(() => conn.abort(new Stalled()), stallMs);
    };
    try {
      armStall();
      const headers: Record<string, string> = { Accept: "text/event-stream", ...(await opts.headers()) };
      if (lastSeq > 0) headers["Last-Event-ID"] = String(lastSeq);
      const res = await fetchFn(opts.url, { headers, signal: conn.signal, cache: "no-store" });
      if (!res.ok || !res.body) {
        let error = { code: "http_error", message: `job stream: HTTP ${res.status}`, retryable: res.status >= 500 };
        try {
          const body = (await res.json()) as typeof error;
          if (typeof body?.code === "string") error = body;
        } catch {
          // not the API's error body
        }
        throw new ApiFailure(res.status, error);
      }
      opts.onStatus?.("open");
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      const parser = new SseParser();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return false; // the server closed without a last event: resume
        armStall(); // any bytes, keep-alive comments included, show the connection is alive
        for (const e of parser.feed(value)) {
          if (!EVENTS.has(e.event)) {
            console.warn(`job stream: unknown event ${e.event}`); // additive within a version
            continue;
          }
          const seq = e.id !== null && /^\d+$/.test(e.id) ? Number(e.id) : null;
          if (seq !== null) {
            if (seq <= lastSeq) continue; // already seen (a replay overlapping a reconnect)
            lastSeq = seq;
          }
          const event = (e.data ? { event: e.event, data: JSON.parse(e.data) } : { event: e.event }) as JobEvent;
          opts.onEvent(event, seq);
          if (event.event === "done" || event.event === "error") {
            await reader.cancel().catch(() => undefined);
            return true;
          }
        }
      }
    } finally {
      clearTimeout(stall);
      closed.signal.removeEventListener("abort", abort);
    }
  };

  const run = async (): Promise<void> => {
    let failures = 0;
    opts.onStatus?.("connecting");
    while (!closed.signal.aborted) {
      const before = lastSeq;
      try {
        if (await connect()) return;
      } catch (e) {
        if (closed.signal.aborted) return;
        // The job or the token is gone: reconnecting cannot help.
        if (e instanceof ApiFailure && (e.status === 401 || e.status === 403 || e.status === 404)) throw e;
      }
      if (closed.signal.aborted) return;
      failures = lastSeq > before ? 1 : failures + 1; // progress resets the backoff
      opts.onStatus?.("reconnecting");
      await sleep(backoff[Math.min(failures - 1, backoff.length - 1)]!, closed.signal);
    }
  };

  const finished = run();
  return {
    finished,
    get lastSeq() {
      return lastSeq;
    },
    close: () => closed.abort(),
  };
}
