// Simulation worker (LLD §8), exposed with Comlink. ngspice runs synchronously in here, so the
// watchdog that stops a runaway simulation lives on the main thread (simClient.ts).
//
// ngspice.mjs/.wasm and the registry bundle are static assets; see config.ts for where they live.
import * as Comlink from "comlink";
import { NGSPICE_URL, registryAssetUrl, registryBundleUrl } from "../config.ts";
import { Ngspice, loadModels, simulate, type NgspiceModule } from "./sim.engine.ts";
import type { SimApi, SimRequest, SimResult } from "./sim.types.ts";

const MODEL_ROOT = "/registry"; // MEMFS; netlists include e.g. `models/tl072.lib` relative to it

let models: Record<string, string> | undefined;
let engine: Ngspice | undefined;

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

/** Every model file the registry's parts include, keyed by registry-relative path. */
async function fetchModels(version: string): Promise<Record<string, string>> {
  const bundle = JSON.parse(await fetchText(registryBundleUrl(version))) as {
    parts: Record<string, { spice?: { include?: string } }>;
  };
  const paths = [...new Set(Object.values(bundle.parts).flatMap((p) => p.spice?.include ?? []))].sort();
  const texts = await Promise.all(paths.map((p) => fetchText(registryAssetUrl(version, p))));
  return Object.fromEntries(paths.map((p, i) => [p, texts[i]!]));
}

async function startEngine(): Promise<Ngspice> {
  const { default: createNgspice } = (await import(/* @vite-ignore */ NGSPICE_URL)) as {
    default: () => Promise<NgspiceModule>;
  };
  const ng = new Ngspice(await createNgspice());
  loadModels(ng, MODEL_ROOT, models ?? {});
  return ng;
}

const api: SimApi = {
  async init(registryVersion: string): Promise<void> {
    models = await fetchModels(registryVersion);
    engine = await startEngine();
  },

  async run(req: SimRequest): Promise<SimResult> {
    if (!models) throw new Error("sim worker: init() first");
    if (!engine || engine.broken) engine = await startEngine(); // ngspice exited: fresh instance
    const result = simulate(engine, req);
    const buffers = result.vectors.flatMap((v) => (v.imag ? [v.data.buffer, v.imag.buffer] : [v.data.buffer]));
    return Comlink.transfer(result, buffers as ArrayBuffer[]);
  },
};

Comlink.expose(api);
