// The SSE parser on awkward chunking, and the job stream against a scripted server: resume with
// Last-Event-ID after a drop or a stall, nothing seen twice, and the ways a stream ends.
import { describe, expect, it } from "vitest";
import { ApiFailure } from "../api/client.ts";
import type { JobEvent } from "../gen/contract.ts";
import { openJobStream } from "./jobStream.ts";
import { SseParser } from "./sse.ts";

describe("SseParser", () => {
  it("parses events split anywhere, with any line ending, comments and multi-line data", () => {
    const text = ": keep-alive\r\nid: 1\r\nevent: job.state\r\ndata: {\"state\":\r\ndata: \"planning\"}\r\n\r\nevent: heartbeat\n\nid: 2\revent: op\rdata: {}\r\r";
    for (const size of [1, 2, 3, 7, text.length]) {
      const p = new SseParser();
      const events = [];
      for (let i = 0; i < text.length; i += size) events.push(...p.feed(text.slice(i, i + size)));
      expect(events).toEqual([
        { id: "1", event: "job.state", data: '{"state":\n"planning"}' },
        { id: null, event: "heartbeat", data: "" },
        { id: "2", event: "op", data: "{}" },
      ]);
    }
  });
});

/** A server whose replies are scripted per request: `chunks` then close, or hang (a stall). */
function server(replies: ((req: { headers: Record<string, string> }) => { status?: number; chunks?: string[]; hang?: boolean; body?: string })[]) {
  const seen: Record<string, string>[] = [];
  const fetch = async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = init?.headers as Record<string, string>;
    seen.push(headers);
    const reply = replies.shift()?.({ headers });
    if (!reply) throw new TypeError("connection refused");
    if (reply.status && reply.status !== 200) return new Response(reply.body ?? "", { status: reply.status });
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of reply.chunks ?? []) c.enqueue(new TextEncoder().encode(chunk));
        if (!reply.hang) c.close();
        signal?.addEventListener("abort", () => c.error(signal.reason));
      },
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  return { fetch: fetch as typeof globalThis.fetch, seen };
}

const ev = (id: number | null, event: string, data?: unknown) =>
  `${id === null ? "" : `id: ${id}\n`}event: ${event}\n${data === undefined ? "" : `data: ${JSON.stringify(data)}\n`}\n`;

const quick = { backoffMs: [1], sleep: () => Promise.resolve() };

describe("openJobStream", () => {
  it("reads until done, resuming after a dropped connection without repeating events", async () => {
    const s = server([
      () => ({ chunks: [ev(1, "job.state", { state: "queued" }), ev(2, "job.state", { state: "planning" }).slice(0, 20)] }),
      () => ({ chunks: [ev(2, "job.state", { state: "planning" }), ev(null, "heartbeat"), ev(3, "done", { rev: 4, usage: { in_tokens: 1, out_tokens: 1 } })] }),
    ]);
    const got: [string, number | null][] = [];
    const stream = openJobStream({
      url: "/v1/jobs/j/events",
      headers: async () => ({ Authorization: "Bearer t" }),
      onEvent: (e: JobEvent, seq) => got.push([e.event, seq]),
      fetch: s.fetch,
      ...quick,
    });
    await stream.finished;
    expect(got).toEqual([
      ["job.state", 1],
      ["job.state", 2],
      ["heartbeat", null],
      ["done", 3],
    ]);
    expect(s.seen.map((h) => [h.Authorization, h["Last-Event-ID"]])).toEqual([
      ["Bearer t", undefined],
      ["Bearer t", "1"],
    ]);
    expect(stream.lastSeq).toBe(3);
  });

  it("reconnects when the stream stalls, and after server errors", async () => {
    const s = server([
      () => ({ chunks: [ev(5, "job.state", { state: "composing", block: "b1" })], hang: true }),
      () => ({ status: 503, body: "" }),
      () => ({ chunks: [ev(5, "job.state", { state: "composing" }), ev(6, "error", { code: "job_lost", message: "lost", retryable: true })] }),
    ]);
    const got: string[] = [];
    const statuses: string[] = [];
    const stream = openJobStream({
      url: "/e",
      headers: async () => ({}),
      after: 4,
      onEvent: (e) => got.push(e.event === "error" ? `error ${e.data.code}` : e.event),
      onStatus: (st) => statuses.push(st),
      fetch: s.fetch,
      stallMs: 30,
      ...quick,
    });
    await stream.finished;
    expect(got).toEqual(["job.state", "error job_lost"]);
    expect(s.seen.map((h) => h["Last-Event-ID"])).toEqual(["4", "5", "5"]);
    expect(statuses).toEqual(["connecting", "open", "reconnecting", "reconnecting", "open"]);
  });

  it("gives up on a job that is not there", async () => {
    const s = server([() => ({ status: 404, body: JSON.stringify({ code: "not_found", message: "job not found" }) })]);
    const stream = openJobStream({ url: "/e", headers: async () => ({}), onEvent: () => {}, fetch: s.fetch, ...quick });
    const err = await stream.finished.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiFailure);
    expect((err as ApiFailure).code).toBe("not_found");
  });

  it("stops when closed", async () => {
    const s = server([() => ({ chunks: [], hang: true })]);
    const stream = openJobStream({ url: "/e", headers: async () => ({}), onEvent: () => {}, fetch: s.fetch, ...quick });
    await new Promise((r) => setTimeout(r, 5));
    stream.close();
    await stream.finished;
    expect(s.seen).toHaveLength(1);
  });
});
