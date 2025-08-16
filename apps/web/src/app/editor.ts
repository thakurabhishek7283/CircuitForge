// Everything one open circuit needs: the WASM core session, the store mirroring it, and the
// layout and simulation workers kept in step with it.
import init, { CoreRegistry, CoreSession } from "@tutor/core";
import { registryAssetUrl, registryBundleUrl } from "../config.ts";
import type { Circuit, Registry } from "../gen/contract.ts";
import { type CircuitStore, createCircuitStore } from "../store/circuitStore.ts";
import { attachLayout } from "../store/layoutSync.ts";
import { attachSimulation } from "../store/simulation.ts";
import { LayoutClient, layoutRegistry } from "../workers/layoutClient.ts";
import { SimClient } from "../workers/simClient.ts";

export interface Editor {
  store: CircuitStore;
  registry: Registry;
  sprite: string;
  dispose(): void;
}

// One WASM instance per page. wasm-bindgen's init() is not safe to run concurrently: a second
// instantiation replaces the module's exports, and objects made by the first then index the wrong
// memory. (React StrictMode opens the editor twice in development.)
let coreReady: Promise<unknown> | undefined;
const initCore = () => (coreReady ??= init());

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

/** Open a circuit snapshot. Its registry version picks the bundle; projects never switch silently. */
export async function openEditor(snapshotJson: string): Promise<Editor> {
  const version = (JSON.parse(snapshotJson) as Circuit).registry_version;
  const [, bundleJson, sprite] = await Promise.all([
    initCore(),
    fetchText(registryBundleUrl(version)),
    fetchText(registryAssetUrl(version, "symbols.svg")),
  ]);
  const session = new CoreSession(CoreRegistry.fromJson(bundleJson), snapshotJson);
  const registry = JSON.parse(bundleJson) as Registry;
  const store = createCircuitStore(session);

  const layout = new LayoutClient(layoutRegistry(registry));
  const sim = new SimClient(version); // ngspice.wasm loads on the first run, after first paint
  const stops = [attachLayout(store, (input) => layout.request(input)), attachSimulation(store, session, sim)];

  return {
    store,
    registry,
    sprite,
    dispose() {
      for (const stop of stops) stop();
      layout.dispose();
      sim.dispose();
      session.free();
    },
  };
}
