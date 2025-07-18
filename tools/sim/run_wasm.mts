// Simulation parity, WASM side: run netlists through the browser engine (sim.engine.ts on
// ngspice.wasm) and write the results as JSON. Driven by test_wasm_parity.py.
// usage: node tools/sim/run_wasm.mts <requests.json> <results.json>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import createNgspice from "../../third_party/ngspice/dist/wasm/ngspice.mjs";
import { Ngspice, loadModels, simulate } from "../../apps/web/src/workers/sim.engine.ts";

const repo = join(import.meta.dirname, "../..");
const [requestsPath, resultsPath] = process.argv.slice(2);
const requests: { netlist: string; includes: string[]; hash: string }[] = JSON.parse(readFileSync(requestsPath!, "utf8"));

const includes = [...new Set(requests.flatMap((r) => r.includes))];
const ng = new Ngspice(await createNgspice());
loadModels(ng, "/registry", Object.fromEntries(includes.map((p) => [p, readFileSync(join(repo, "registry", p), "utf8")])));

const results = requests.map((req) => {
  const r = simulate(ng, { netlist: req.netlist, hash: req.hash, analyses: [] });
  return {
    ...r,
    vectors: r.vectors.map((v) => ({ ...v, data: [...v.data], imag: v.imag ? [...v.imag] : null })),
  };
});
writeFileSync(resultsPath!, JSON.stringify(results));
