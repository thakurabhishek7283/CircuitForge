import { describe, expect, it, vi } from "vitest";
import { SimClient, type SimWorkerHandle } from "./simClient.ts";
import type { SimRequest, SimResult } from "./sim.types.ts";

const req: SimRequest = { netlist: "* t\n.end\n", hash: "h1", analyses: [{ type: "op" }] };
const okResult: SimResult = { hash: "h1", vectors: [], meas: {}, status: "ok", log: "", ms: 1 };

function fakeWorker(run: () => Promise<SimResult>) {
  const handle: SimWorkerHandle & { terminated: boolean } = {
    terminated: false,
    api: { init: vi.fn(async () => {}), run: vi.fn(run) },
    terminate() {
      this.terminated = true;
    },
  };
  return handle;
}

describe("SimClient watchdog", () => {
  it("returns the worker's result", async () => {
    const w = fakeWorker(async () => okResult);
    const client = new SimClient("v1", { spawn: () => w });
    await expect(client.run(req)).resolves.toEqual(okResult);
    expect(w.api.init).toHaveBeenCalledWith("v1");
  });

  it("terminates a runaway worker, reports a timeout and respawns on the next run", async () => {
    const hung = fakeWorker(() => new Promise<SimResult>(() => {}));
    const fresh = fakeWorker(async () => okResult);
    const spawn = vi.fn().mockReturnValueOnce(hung).mockReturnValueOnce(fresh);
    const client = new SimClient("v1", { spawn, timeoutMs: 20 });

    const r = await client.run(req);
    expect(r.status).toBe("timeout");
    expect(r.hash).toBe("h1");
    expect(hung.terminated).toBe(true);

    await expect(client.run(req)).resolves.toEqual(okResult);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(fresh.api.init).toHaveBeenCalledOnce();
  });

  it("does not count worker start-up against the watchdog", async () => {
    const w = fakeWorker(async () => okResult);
    w.api.init = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
    const client = new SimClient("v1", { spawn: () => w, timeoutMs: 20 });
    await expect(client.run(req)).resolves.toEqual(okResult);
  });

  it("retries a failed start-up with a fresh worker", async () => {
    const broken = fakeWorker(async () => okResult);
    broken.api.init = vi.fn(async () => {
      throw new Error("ngspice.wasm: HTTP 404");
    });
    const good = fakeWorker(async () => okResult);
    const client = new SimClient("v1", { spawn: vi.fn().mockReturnValueOnce(broken).mockReturnValueOnce(good) });
    await expect(client.run(req)).rejects.toThrow(/404/);
    expect(broken.terminated).toBe(true);
    await expect(client.run(req)).resolves.toEqual(okResult);
  });
});
