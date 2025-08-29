// Simulation scheduling: debounce, latest-wins by netlist hash, skipping unchanged netlists, and
// node voltages from a real OP run (core + ngspice WASM, as in the browser minus the worker).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SimRequest, SimResult } from "../workers/sim.types.ts";
import { Ngspice, loadModels, simulate, type NgspiceModule } from "../workers/sim.engine.ts";
import { bundleJson, demoJson, loadCore, missingArtifacts, repo } from "../test/artifacts.ts";
import { createCircuitStore } from "./circuitStore.ts";
import { SIM_DEBOUNCE_MS, attachSimulation } from "./simulation.ts";
import { buildSimView } from "./simView.ts";

const ngspiceJs = join(repo, "third_party/ngspice/dist/wasm/ngspice.mjs");
const missing = missingArtifacts();

function setup() {
  const core = loadCore();
  const session = new core.CoreSession(core.CoreRegistry.fromJson(bundleJson()), demoJson());
  return { session, store: createCircuitStore(session) };
}

/** A runner whose runs the test resolves by hand. */
function manualRunner() {
  const runs: { req: SimRequest; resolve: (r: SimResult) => void }[] = [];
  return {
    runs,
    run: (req: SimRequest) => new Promise<SimResult>((resolve) => runs.push({ req, resolve })),
  };
}

const ok = (hash: string, vout = 1): SimResult => ({
  hash,
  vectors: [
    { name: "v(n_out)", analysis: "op", unit: "V", data: Float64Array.of(vout) },
    { name: "v(vcc)", analysis: "op", unit: "V", data: Float64Array.of(12) },
  ],
  meas: {},
  status: "ok",
  log: "",
  ms: 1,
});

const setR1 = (value: string) => ({ op: "part.set_param" as const, body: { refdes: "R1", key: "resistance", value } });

describe.skipIf(missing.length > 0)("simulation scheduling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs once per burst of edits, after the debounce", async () => {
    const { store, session } = setup();
    const runner = manualRunner();
    attachSimulation(store, session, runner);
    expect(store.getState().sim.status).toBe("pending");
    await vi.advanceTimersByTimeAsync(SIM_DEBOUNCE_MS);
    expect(runner.runs).toHaveLength(1);
    runner.runs[0]!.resolve(ok(runner.runs[0]!.req.hash));
    await vi.runAllTimersAsync();

    for (const v of ["1k", "2k", "3k"]) {
      store.getState().apply(setR1(v));
      await vi.advanceTimersByTimeAsync(SIM_DEBOUNCE_MS / 3);
    }
    expect(runner.runs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(SIM_DEBOUNCE_MS);
    expect(runner.runs).toHaveLength(2);
    expect(runner.runs[1]!.req.netlist).toMatch(/^R1 n_in n_a 3e3$/m);
    expect(runner.runs[1]!.req.analyses.map((a) => a.type)).toEqual(["op", "tran", "ac"]);
  });

  it("discards a result that a newer edit has superseded", async () => {
    const { store, session } = setup();
    const runner = manualRunner();
    attachSimulation(store, session, runner);
    await vi.advanceTimersByTimeAsync(SIM_DEBOUNCE_MS);
    store.getState().apply(setR1("1k"));
    await vi.advanceTimersByTimeAsync(SIM_DEBOUNCE_MS);
    expect(runner.runs).toHaveLength(2);
    const [first, second] = runner.runs as [(typeof runner.runs)[0], (typeof runner.runs)[0]];
    expect(first.req.hash).not.toBe(second.req.hash);

    first.resolve(ok(first.req.hash, 5));
    await vi.runAllTimersAsync();
    expect(store.getState().sim.status).toBe("running");
    expect(store.getState().sim.result).toBeUndefined();

    second.resolve(ok(second.req.hash, 2));
    await vi.runAllTimersAsync();
    expect(store.getState().sim).toMatchObject({ status: "ok", hash: second.req.hash });
    expect(store.getState().sim.voltages).toMatchObject({ N_OUT: 2, VCC: 12, GND: 0 });
  });

  it("does not re-run an unchanged netlist", async () => {
    const { store, session } = setup();
    const runner = manualRunner();
    attachSimulation(store, session, runner);
    await vi.advanceTimersByTimeAsync(SIM_DEBOUNCE_MS);
    runner.runs[0]!.resolve(ok(runner.runs[0]!.req.hash));
    await vi.runAllTimersAsync();

    store.getState().apply({ op: "hint.add", body: { hint: { kind: "near", a: "R1", b: "R2" } } });
    await vi.advanceTimersByTimeAsync(SIM_DEBOUNCE_MS);
    expect(runner.runs).toHaveLength(1);
    expect(store.getState().sim.status).toBe("ok");
  });

  it("reports a failed run as an error", async () => {
    const { store, session } = setup();
    attachSimulation(store, session, { run: () => Promise.reject(new Error("worker died")) });
    await vi.runAllTimersAsync();
    expect(store.getState().sim).toMatchObject({ status: "error", message: "worker died" });
  });
});

describe("buildSimView", () => {
  const nets = {
    N_A: { id: "N_A", kind: { kind: "signal" as const }, pins: ["R1.2", "R2.1", "U1.INP_A"] },
    N_B: { id: "N_B", kind: { kind: "signal" as const }, pins: ["R2.2", "U1.OUT_A", "U2.IN"] },
  };
  const netlist = {
    node_map: { N_A: "n_a", N_B: "n_b", GND: "0" },
    pin_currents: {
      "R1.2": [{ vector: "@r1[i]", coeff: -1 }],
      "R2.1": [{ vector: "@r2[i]", coeff: 1 }],
      "R2.2": [{ vector: "@r2[i]", coeff: -1 }],
    },
  };

  it("keys OP and transient values by net and pin, and fills a net's one unknown pin by KCL", () => {
    const r = ok("h", 3);
    r.vectors = [
      { name: "v(n_a)", analysis: "op", unit: "V", data: Float64Array.of(3) },
      { name: "@r1[i]", analysis: "op", unit: "A", data: Float64Array.of(2e-3) },
      { name: "@r2[i]", analysis: "op", unit: "A", data: Float64Array.of(0.5e-3) },
      { name: "time", analysis: "tran", unit: "s", data: Float64Array.of(0, 1) },
      { name: "v(n_a)", analysis: "tran", unit: "V", data: Float64Array.of(9, 8) },
      { name: "@r1[i]", analysis: "tran", unit: "A", data: Float64Array.of(1, 2) },
      { name: "@r2[i]", analysis: "tran", unit: "A", data: Float64Array.of(1, 1) },
    ];
    const view = buildSimView(r, netlist, nets);
    expect(view.op!.v).toEqual({ N_A: 3, GND: 0 });
    expect(view.op!.i["R1.2"]).toBeCloseTo(-2e-3);
    // N_A: R1.2 = -2 mA, R2.1 = +0.5 mA, so 1.5 mA flows into U1.INP_A.
    expect(view.op!.i["U1.INP_A"]).toBeCloseTo(1.5e-3);
    // N_B has two pins without a saved current: KCL cannot say how they share it.
    expect(view.op!.i["U1.OUT_A"]).toBeUndefined();
    expect([...view.tran!.x]).toEqual([0, 1]);
    expect([...view.tran!.v.N_A!]).toEqual([9, 8]);
    expect([...view.tran!.i["U1.INP_A"]!]).toEqual([0, 1]);
    expect(view.ac).toBeNull();
  });
});

describe.skipIf(missing.length > 0 || !existsSync(ngspiceJs))("simulation on ngspice WASM", () => {
  it("shows the demo's OP node voltages after an edit", async () => {
    const { store, session } = setup();
    const { default: createNgspice } = (await import(ngspiceJs)) as { default: () => Promise<NgspiceModule> };
    const ng = new Ngspice(await createNgspice());
    const models = ["models/tl072.lib"];
    loadModels(ng, "/registry", Object.fromEntries(models.map((p) => [p, readFileSync(join(repo, "registry", p), "utf8")])));
    attachSimulation(store, session, { run: async (req) => simulate(ng, req) }, { debounceMs: 0 });

    store.getState().apply({ op: "part.set_param", body: { refdes: "V3", key: "offset", value: "1" } });
    await vi.waitFor(() => expect(store.getState().sim.status).toBe("ok"), { timeout: 5000 });
    const v = store.getState().sim.voltages;
    expect(v.VCC).toBeCloseTo(12, 6);
    expect(v.VEE).toBeCloseTo(-12, 6);
    expect(v.N_IN).toBeCloseTo(1, 6);
    expect(v.N_OUT).toBeCloseTo(1, 2); // unity-gain low-pass passes DC
  });
});
