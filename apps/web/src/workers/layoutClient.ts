// Main-thread side of the layout worker. Latest wins: while a layout runs, newer requests replace
// each other and only the newest runs next; superseded requests resolve with null.
import * as Comlink from "comlink";
import type { Circuit, Registry } from "../gen/contract.ts";
import type { Layout, LayoutApi, LayoutInput, LayoutRegistry } from "./layout.types.ts";

export interface LayoutWorkerHandle {
  api: Pick<LayoutApi, "init" | "layout">;
  terminate(): void;
}

function spawnWorker(): LayoutWorkerHandle {
  const worker = new Worker(new URL("./layout.worker.ts", import.meta.url), { type: "module" });
  return { api: Comlink.wrap<LayoutApi>(worker), terminate: () => worker.terminate() };
}

/** The part of the registry bundle the layout needs (no params, models or SPICE). */
export function layoutRegistry(reg: Registry): LayoutRegistry {
  const parts: LayoutRegistry["parts"] = {};
  for (const [id, p] of Object.entries(reg.parts)) {
    if (!p) continue;
    parts[id] = { symbol: p.symbol, units: p.units ?? [], pins: p.pins.map(({ name, unit, type }) => ({ name, unit, type })) };
  }
  const symbols: LayoutRegistry["symbols"] = {};
  for (const [id, s] of Object.entries(reg.symbols)) if (s) symbols[id] = s;
  return { parts, symbols };
}

/**
 * The layout's view of a circuit: topology and pinned placements only. Nets are sorted by id, so
 * the result never depends on the order nets were created or renamed in.
 */
export function toLayoutInput(c: Pick<Circuit, "parts" | "nets" | "blocks">): LayoutInput {
  const values = <T>(r: Record<string, T | undefined>) => Object.values(r).filter((v): v is T => v !== undefined);
  return {
    parts: values(c.parts).map(({ refdes, part, block, pinned }) => ({ refdes, part, block, pinned })),
    nets: values(c.nets)
      .map(({ id, kind, label, pins }) => ({ id, kind, label, pins }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    blocks: values(c.blocks).map(({ id, title, ports }) => ({ id, title, ports })),
  };
}

export class LayoutClient {
  private readonly handle: LayoutWorkerHandle;
  private readonly ready: Promise<void>;
  private pending: { input: LayoutInput; resolve: (l: Layout | null) => void; reject: (e: unknown) => void } | null = null;
  private running = false;

  constructor(registry: LayoutRegistry, spawn: () => LayoutWorkerHandle = spawnWorker) {
    this.handle = spawn();
    this.ready = this.handle.api.init(registry);
  }

  request(input: LayoutInput): Promise<Layout | null> {
    return new Promise((resolve, reject) => {
      this.pending?.resolve(null);
      this.pending = { input, resolve, reject };
      if (!this.running) void this.pump();
    });
  }

  dispose(): void {
    this.pending?.resolve(null);
    this.pending = null;
    this.handle.terminate();
  }

  private async pump(): Promise<void> {
    this.running = true;
    try {
      await this.ready;
      while (this.pending) {
        const job = this.pending;
        this.pending = null;
        try {
          job.resolve(await this.handle.api.layout(job.input));
        } catch (e) {
          job.reject(e);
        }
      }
    } catch (e) {
      this.pending?.reject(e); // init failed
      this.pending = null;
    } finally {
      this.running = false;
    }
  }
}
