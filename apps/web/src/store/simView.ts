// A simulation result in the IR's terms (LLD §8, §10): node voltages by net id and pin currents
// by `REFDES.PIN`, per analysis. Built once per result from the netlist's node map and pin-current
// map, so nothing downstream parses vector names. Pins inside subcircuit models (op-amps,
// regulators) have no saved current; where a net has exactly one such pin, KCL supplies it.
import type { Net, Netlist } from "../gen/contract.ts";
import type { SimResult, SimVector } from "../workers/sim.types.ts";

export interface TimeSeries {
  /** Sweep variable: time (s) or frequency (Hz). */
  x: Float64Array;
  v: Record<string, Float64Array>;
}

export interface SimView {
  /** Operating point. */
  op: { v: Record<string, number>; i: Record<string, number> } | null;
  tran: (TimeSeries & { i: Record<string, Float64Array> }) | null;
  /** AC: real parts in `v`, imaginary parts in `vi`. */
  ac: (TimeSeries & { vi: Record<string, Float64Array> }) | null;
}

export type ViewNetlist = Pick<Netlist, "node_map" | "pin_currents">;

/** Analysis -> vector name -> vector. */
function index(result: SimResult): Map<string, Map<string, SimVector>> {
  const out = new Map<string, Map<string, SimVector>>();
  for (const v of result.vectors) {
    let m = out.get(v.analysis);
    if (!m) out.set(v.analysis, (m = new Map()));
    m.set(v.name, v);
  }
  return out;
}

function voltages(vecs: Map<string, SimVector>, nodeMap: Netlist["node_map"], len: number): Record<string, Float64Array> {
  const v: Record<string, Float64Array> = {};
  for (const [net, node] of Object.entries(nodeMap)) {
    if (node === "0") v[net] = new Float64Array(len);
    else {
      const vec = node && vecs.get(`v(${node})`);
      if (vec) v[net] = vec.data;
    }
  }
  return v;
}

/** Pin currents from the netlist's map, then by KCL for a net's one unknown pin. */
function currents(
  vecs: Map<string, SimVector>,
  map: Netlist["pin_currents"],
  nets: Record<string, Net | undefined>,
  len: number,
): Record<string, Float64Array> {
  const i: Record<string, Float64Array> = {};
  for (const [pin, terms] of Object.entries(map)) {
    const out = new Float64Array(len);
    let complete = true;
    for (const t of terms ?? []) {
      const vec = vecs.get(t.vector);
      if (!vec || vec.data.length !== len) {
        complete = false;
        break;
      }
      for (let k = 0; k < len; k++) out[k]! += t.coeff * vec.data[k]!;
    }
    if (complete) i[pin] = out;
  }
  for (const net of Object.values(nets)) {
    if (!net) continue;
    const unknown = net.pins.filter((p) => !i[p]);
    if (unknown.length !== 1 || net.pins.length < 2) continue;
    const out = new Float64Array(len);
    for (const p of net.pins) {
      const known = i[p];
      if (known) for (let k = 0; k < len; k++) out[k]! -= known[k]!;
    }
    i[unknown[0]!] = out;
  }
  return i;
}

export function buildSimView(result: SimResult, netlist: ViewNetlist, nets: Record<string, Net | undefined>): SimView {
  const byAnalysis = index(result);
  const view: SimView = { op: null, tran: null, ac: null };

  const op = byAnalysis.get("op");
  if (op) {
    const v = voltages(op, netlist.node_map, 1);
    const i = currents(op, netlist.pin_currents, nets, 1);
    view.op = {
      v: Object.fromEntries(Object.entries(v).map(([k, a]) => [k, a[0]!])),
      i: Object.fromEntries(Object.entries(i).map(([k, a]) => [k, a[0]!])),
    };
  }

  const tran = byAnalysis.get("tran");
  const time = tran?.get("time");
  if (tran && time) {
    const n = time.data.length;
    view.tran = { x: time.data, v: voltages(tran, netlist.node_map, n), i: currents(tran, netlist.pin_currents, nets, n) };
  }

  const ac = byAnalysis.get("ac");
  const freq = ac?.get("frequency");
  if (ac && freq) {
    const n = freq.data.length;
    const v = voltages(ac, netlist.node_map, n);
    const vi: Record<string, Float64Array> = {};
    for (const [net, node] of Object.entries(netlist.node_map)) {
      vi[net] = (node && node !== "0" && ac.get(`v(${node})`)?.imag) || new Float64Array(n);
    }
    view.ac = { x: freq.data, v, vi };
  }
  return view;
}
