// Simulation worker (LLD §8), exposed with Comlink. ngspice runs synchronously in here, so the
// watchdog that stops a runaway simulation lives on the main thread (simClient.ts).
//
// Deployment: ngspice.mjs/.wasm (third_party/ngspice/dist/wasm) and the registry bundle
// (cargo run -p circuit-core --example bundle_registry) are static assets, by default served at
// /ngspice/ and /registry/; VITE_NGSPICE_URL and VITE_REGISTRY_URL point them elsewhere (CDN).
import * as Comlink from "comlink";
import { Ngspice, loadModels, simulate, type NgspiceModule } from "./sim.engine.ts";
import type { SimApi, SimRequest, SimResult } from "./sim.types.ts";

const NGSPICE_URL = import.meta.env?.VITE_NGSPICE_URL ?? "/ngspice/ngspice.mjs";
const REGISTRY_URL = import.meta.env?.VITE_REGISTRY_URL ?? "/registry";
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
  const bundle = JSON.parse(await fetchText(`${REGISTRY_URL}/registry-${version}.json`)) as {
    parts: Record<string, { spice?: { include?: string } }>;
  };
  const paths = [...new Set(Object.values(bundle.parts).flatMap((p) => p.spice?.include ?? []))].sort();
  const texts = await Promise.all(paths.map((p) => fetchText(`${REGISTRY_URL}/registry-${version}/${p}`)));
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
