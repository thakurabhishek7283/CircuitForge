// The REST client against a scripted fetch: one anonymous session however many calls race for it,
// the API's own errors passed through, an unreachable server reported as offline, an empty 202.
import { describe, expect, it } from "vitest";
import { ApiClient, ApiFailure, type TokenStore } from "./client.ts";

function memoryTokens(token: string | null = null): TokenStore & { value: string | null } {
  return {
    value: token,
    get() {
      return this.value;
    },
    set(t) {
      this.value = t;
    },
  };
}

type Reply = Response | Error;

function client(replies: Record<string, () => Reply>, tokens = memoryTokens()) {
  const calls: string[] = [];
  const fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(url)}`;
    calls.push(`${key} ${(init?.headers as Record<string, string>)?.Authorization ?? "-"}`);
    const reply = replies[key]?.();
    if (!reply || reply instanceof Error) throw reply ?? new TypeError("Failed to fetch");
    return reply;
  };
  return { api: new ApiClient({ base: "https://api.test/", tokens, fetch: fetch as typeof globalThis.fetch }), calls, tokens };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("ApiClient", () => {
  it("creates one anonymous session for concurrent calls and sends its token", async () => {
    const { api, calls, tokens } = client({
      "POST https://api.test/v1/auth/anonymous": () => json(201, { token: "T1", user_id: "u", expires_in: 60 }),
      "POST https://api.test/v1/projects": () => json(201, { id: "p" }),
    });
    await Promise.all([api.createProject(), api.createProject()]);
    expect(calls).toEqual([
      "POST https://api.test/v1/auth/anonymous -",
      "POST https://api.test/v1/projects Bearer T1",
      "POST https://api.test/v1/projects Bearer T1",
    ]);
    expect(tokens.value).toBe("T1");
  });

  it("passes the API's errors through, and drops a token the server refuses", async () => {
    const { api, tokens } = client(
      {
        "GET https://api.test/v1/projects/x": () => json(404, { code: "not_found", message: "project not found" }),
        "GET https://api.test/v1/projects/y": () => json(401, { code: "unauthorized", message: "invalid token" }),
      },
      memoryTokens("OLD"),
    );
    await expect(api.getProject("x")).rejects.toMatchObject({ status: 404, code: "not_found", retryable: false });
    expect(tokens.value).toBe("OLD");
    await expect(api.getProject("y")).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    expect(tokens.value).toBeNull();
  });

  it("reports an unreachable server as offline, whether the network or a gateway says so", async () => {
    const { api } = client(
      {
        "GET https://api.test/v1/projects/a": () => new TypeError("Failed to fetch"),
        "GET https://api.test/v1/projects/b": () => new Response("Bad Gateway", { status: 502 }),
        "GET https://api.test/v1/projects/c": () => new Response("", { status: 500 }),
        "GET https://api.test/v1/projects/d": () => json(503, { code: "generation_unavailable", message: "no", retryable: true }),
      },
      memoryTokens("T"),
    );
    for (const id of ["a", "b", "c"]) {
      const e = await api.getProject(id).catch((err: unknown) => err);
      expect(e).toBeInstanceOf(ApiFailure);
      expect((e as ApiFailure).code).toBe("offline");
      expect((e as ApiFailure).retryable).toBe(true);
    }
    await expect(api.getProject("d")).rejects.toMatchObject({ code: "generation_unavailable", retryable: true });
  });

  it("accepts an empty 202 (cancel)", async () => {
    const { api } = client({ "POST https://api.test/v1/jobs/j/cancel": () => new Response(null, { status: 202 }) }, memoryTokens("T"));
    await expect(api.cancel("j")).resolves.toBeUndefined();
    expect(api.eventsUrl("j")).toBe("https://api.test/v1/jobs/j/events");
  });
});
