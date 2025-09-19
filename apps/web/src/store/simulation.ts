// Re-simulation after edits (LLD §8): debounced 150 ms, compiled by the core, latest wins by
// netlist hash. A result whose hash is no longer the store's is discarded; an edit that leaves the
// netlist unchanged (a layout hint, an undo back to the simulated state) runs nothing.
//
// What runs is the core's interactive set (CompileOpts.interactive): OP, a short transient (or
// the circuit's own), and any AC or DC sweep the circuit asked for with analysis.set. Template
// blocks' spec checks ride along as `.meas` cards; the core turns their results into checks.
import type { Analysis, CheckResult, CompileError, Netlist } from "../gen/contract.ts";
import { type CoreSessionLike, expectOk, outcome } from "../core/types.ts";
import type { SimRequest, SimResult } from "../workers/sim.types.ts";
import type { CircuitStore } from "./circuitStore.ts";
import { buildSimView } from "./simView.ts";

export const SIM_DEBOUNCE_MS = 150;

export interface SimRunner {
  run(req: SimRequest): Promise<SimResult>;
}

export interface SimulationOptions {
  debounceMs?: number;
  /** Override the interactive set (tests). */
  analyses?: Analysis[];
  /** The core's `evaluateChecks`; without it spec checks are not evaluated. */
  evaluateChecks?: (checks: string, meas: string) => string;
}

/** Keep `store.sim` in step with the circuit. Returns a function that stops it. */
export function attachSimulation(
  store: CircuitStore,
  core: CoreSessionLike,
  sim: SimRunner,
  opts: SimulationOptions = {},
): () => void {
  const debounceMs = opts.debounceMs ?? SIM_DEBOUNCE_MS;
  const compileOpts = JSON.stringify({ shunt_floating: true, interactive: true, analyses: opts.analyses });
  const setSim = store.getState().setSim;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = () => {
    const state = store.getState();
    if (Object.keys(state.parts).length === 0) {
      setSim((s) => Object.assign(s, { hash: null, status: "idle", result: undefined, view: undefined, voltages: {}, checks: undefined, message: undefined }));
      return;
    }
    const compiled = outcome<Netlist, CompileError>(core.compile(compileOpts));
    if (compiled.err) {
      const message = compiled.err.refdes ? `${compiled.err.refdes}: ${compiled.err.message}` : compiled.err.message;
      setSim((s) => Object.assign(s, { hash: null, status: "error", result: undefined, view: undefined, voltages: {}, checks: undefined, message }));
      return;
    }
    const n = compiled.ok;
    if (n.hash === state.sim.hash && state.sim.result) {
      setSim((s) => {
        s.status = s.result!.status;
      });
      return;
    }
    setSim((s) => Object.assign(s, { hash: n.hash, status: "running", analyses: n.analyses, message: undefined }));
    const nets = state.nets; // the topology this netlist was compiled from
    sim.run({ netlist: n.text, hash: n.hash, analyses: n.analyses }).then(
      (result) => {
        if (store.getState().sim.hash !== result.hash) return; // superseded by a newer edit
        const view = buildSimView(result, n, nets);
        const voltages = view.op?.v ?? {};
        const checks = opts.evaluateChecks
          ? expectOk<CheckResult[]>(opts.evaluateChecks(JSON.stringify(n.checks), JSON.stringify(result.meas)), "evaluateChecks")
          : undefined;
        setSim((s) => Object.assign(s, { status: result.status, result, view, voltages, checks }));
      },
      (e: unknown) => {
        if (store.getState().sim.hash !== n.hash) return;
        setSim((s) => Object.assign(s, { status: "error", message: e instanceof Error ? e.message : String(e) }));
      },
    );
  };

  const schedule = () => {
    clearTimeout(timer);
    setSim((s) => {
      if (s.status !== "running") s.status = "pending";
    });
    timer = setTimeout(run, debounceMs);
  };

  const unsubscribe = store.subscribe((s, prev) => {
    if (s.rev !== prev.rev) schedule();
  });
  schedule();
  return () => {
    unsubscribe();
    clearTimeout(timer);
  };
}
