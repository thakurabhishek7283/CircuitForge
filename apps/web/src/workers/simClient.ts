// Main-thread side of the simulation worker. ngspice runs synchronously inside the worker and
// cannot be interrupted there, so the 2 s watchdog (LLD §8) terminates the whole worker and the
// next run starts a fresh one. Latest-wins scheduling and debouncing belong to the store.
import * as Comlink from "comlink";
import type { SimApi, SimRequest, SimResult } from "./sim.types.ts";

export const SIM_TIMEOUT_MS = 2000;

export interface SimWorkerHandle {
  api: Pick<SimApi, "init" | "run">;
  terminate(): void;
}

export interface SimClientOptions {
  timeoutMs?: number;
  /** Starts a worker; tests substitute a fake. */
  spawn?: () => SimWorkerHandle;
}

function spawnWorker(): SimWorkerHandle {
  const worker = new Worker(new URL("./sim.worker.ts", import.meta.url), { type: "module" });
  return { api: Comlink.wrap<SimApi>(worker), terminate: () => worker.terminate() };
}

export class SimClient {
  private readonly registryVersion: string;
  private readonly timeoutMs: number;
  private readonly spawn: () => SimWorkerHandle;
  private current?: { handle: SimWorkerHandle; ready: Promise<void> };

  constructor(registryVersion: string, opts: SimClientOptions = {}) {
    this.registryVersion = registryVersion;
    this.timeoutMs = opts.timeoutMs ?? SIM_TIMEOUT_MS;
    this.spawn = opts.spawn ?? spawnWorker;
  }

  /** Start the worker and load ngspice ahead of the first run (e.g. after first paint). */
  warmUp(): Promise<void> {
    return this.worker().ready;
  }

  async run(req: SimRequest): Promise<SimResult> {
    const w = this.worker();
    await w.ready; // loading ngspice and the models does not count against the watchdog
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.timeoutMs);
    });
    try {
      const outcome = await Promise.race([w.handle.api.run(req), timeout]);
      if (outcome !== "timeout") return outcome;
    } finally {
      clearTimeout(timer);
    }
    this.kill(w);
    return {
      hash: req.hash,
      vectors: [],
      meas: {},
      status: "timeout",
      log: `simulation exceeded ${this.timeoutMs} ms; the worker was restarted`,
      ms: performance.now() - started,
    };
  }

  dispose(): void {
    if (this.current) this.kill(this.current);
  }

  private worker(): { handle: SimWorkerHandle; ready: Promise<void> } {
    if (!this.current) {
      const handle = this.spawn();
      const w = { handle, ready: Promise.resolve(handle.api.init(this.registryVersion)) };
      w.ready.catch(() => this.kill(w)); // a failed init is retried with a fresh worker next time
      this.current = w;
    }
    return this.current;
  }

  private kill(w: { handle: SimWorkerHandle }): void {
    w.handle.terminate();
    if (this.current === w) this.current = undefined;
  }
}
