// Re-simulation after edits (LLD §8): debounced 150 ms, compiled by the core, latest wins by
// netlist hash. A result whose hash is no longer the store's is discarded; an edit that leaves the
// netlist unchanged (a layout hint, an undo back to the simulated state) runs nothing.
import type { Analysis, CompileError, Netlist } from "../gen/contract.ts";
import { type CoreSessionLike, outcome } from "../core/types.ts";
import type { SimRequest, SimResult } from "../workers/sim.types.ts";
import type { CircuitStore } from "./circuitStore.ts";

export const SIM_DEBOUNCE_MS = 150;

/**
 * Interactive analyses. LLD §8's default is OP plus a short transient; the transient only feeds
 * the scope panel, so it joins when that panel does and nothing burns CPU on an unseen trace.
 */
export const INTERACTIVE_ANALYSES: Analysis[] = [{ type: "op" }];

export interface SimRunner {
  run(req: SimRequest): Promise<SimResult>;
}

export interface SimulationOptions {
  debounceMs?: number;
  analyses?: Analysis[];
}

/** Node voltages from the OP plot, keyed by IR net id via the netlist's node map. */
export function opVoltages(result: SimResult, nodeMap: Netlist["node_map"]): Record<string, number> {
  const netOfNode = new Map<string, string>();
  for (const [net, node] of Object.entries(nodeMap)) if (node !== undefined) netOfNode.set(node, net);
  const volts: Record<string, number> = {};
  if (netOfNode.has("0")) volts[netOfNode.get("0")!] = 0;
  for (const v of result.vectors) {
    const node = v.analysis === "op" ? /^v\((.+)\)$/.exec(v.name)?.[1] : undefined;
    const net = node && netOfNode.get(node);
    if (net && v.data.length) volts[net] = v.data[0]!;
  }
  return volts;
}

/** Keep `store.sim` in step with the circuit. Returns a function that stops it. */
export function attachSimulation(
  store: CircuitStore,
  core: CoreSessionLike,
  sim: SimRunner,
  opts: SimulationOptions = {},
): () => void {
  const debounceMs = opts.debounceMs ?? SIM_DEBOUNCE_MS;
  const analyses = opts.analyses ?? INTERACTIVE_ANALYSES;
  const setSim = store.getState().setSim;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const run = () => {
    const state = store.getState();
    if (Object.keys(state.parts).length === 0) {
      setSim((s) => Object.assign(s, { hash: null, status: "idle", result: undefined, voltages: {}, message: undefined }));
      return;
    }
    const compiled = outcome<Netlist, CompileError>(core.compile(JSON.stringify({ shunt_floating: true, analyses })));
    if (compiled.err) {
      const message = compiled.err.refdes ? `${compiled.err.refdes}: ${compiled.err.message}` : compiled.err.message;
      setSim((s) => Object.assign(s, { hash: null, status: "error", result: undefined, voltages: {}, message }));
      return;
    }
    const n = compiled.ok;
    if (n.hash === state.sim.hash && state.sim.result) {
      setSim((s) => {
        s.status = s.result!.status;
      });
      return;
    }
    setSim((s) => Object.assign(s, { hash: n.hash, status: "running", message: undefined }));
    sim.run({ netlist: n.text, hash: n.hash, analyses }).then(
      (result) => {
        if (store.getState().sim.hash !== result.hash) return; // superseded by a newer edit
        const voltages = opVoltages(result, n.node_map);
        setSim((s) => Object.assign(s, { status: result.status, result, voltages }));
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
