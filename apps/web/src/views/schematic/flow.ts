// Where current flows in the drawing (LLD §10 overlays). Each signal net's wires are split into
// edges at every vertex, branch and pin, and a spanning tree is taken; the current along an edge
// is then the sum of the pin currents beyond it (KCL), so no per-wire simulation is needed. A
// two-pin part also carries its current through its body, from one pin to the other.
//
// Built once per (layout, netlist); per frame only the pin currents are looked up.
import type { Point } from "../../workers/layout.geometry.ts";
import type { Layout } from "../../workers/layout.types.ts";

export interface FlowEdge {
  a: Point;
  b: Point;
  length: number;
  /** Current from `a` to `b` is the sum of these pins' currents (current into each pin). */
  pins: string[];
}

export interface FlowNet {
  net: string;
  /** For voltage colouring: the net's drawn polylines. */
  polylines: Point[][];
  edges: FlowEdge[];
}

export interface FlowGraph {
  nets: FlowNet[];
  /** Two-pin parts: from the first pin to the second, carrying the first pin's current. */
  bodies: FlowEdge[];
}

const key = (p: Point) => `${Math.round(p.x * 10)},${Math.round(p.y * 10)}`;

function onSegment(a: Point, b: Point, p: Point): boolean {
  const eps = 0.05;
  if (Math.abs(a.x - b.x) < eps) return Math.abs(p.x - a.x) < eps && p.y >= Math.min(a.y, b.y) - eps && p.y <= Math.max(a.y, b.y) + eps;
  if (Math.abs(a.y - b.y) < eps) return Math.abs(p.y - a.y) < eps && p.x >= Math.min(a.x, b.x) - eps && p.x <= Math.max(a.x, b.x) + eps;
  return false; // the layout draws orthogonal wires only
}

/** A net's spanning tree over its wires, with the pins beyond each edge. */
export function netEdges(polylines: Point[][], pinsAt: Map<string, string[]>, pinPoints: Point[]): FlowEdge[] {
  const points = new Map<string, Point>();
  for (const p of [...polylines.flat(), ...pinPoints]) points.set(key(p), p);
  const all = [...points.values()];

  // Elementary segments between consecutive points along every polyline segment.
  const adj = new Map<string, Set<string>>();
  const link = (u: string, v: string) => {
    if (u === v) return;
    (adj.get(u) ?? adj.set(u, new Set()).get(u)!).add(v);
    (adj.get(v) ?? adj.set(v, new Set()).get(v)!).add(u);
  };
  for (const pl of polylines) {
    for (let s = 1; s < pl.length; s++) {
      const a = pl[s - 1]!;
      const b = pl[s]!;
      const along = all.filter((p) => onSegment(a, b, p));
      const dir = { x: b.x - a.x, y: b.y - a.y };
      along.sort((p, q) => (p.x - a.x) * dir.x + (p.y - a.y) * dir.y - ((q.x - a.x) * dir.x + (q.y - a.y) * dir.y));
      for (let i = 1; i < along.length; i++) link(key(along[i - 1]!), key(along[i]!));
    }
  }

  // Spanning forest by BFS (layout overlaps can make cycles; any tree carries the same KCL sums).
  const edges: FlowEdge[] = [];
  const seen = new Set<string>();
  const roots = [...pinsAt.keys(), ...adj.keys()];
  for (const root of roots) {
    if (seen.has(root) || !points.has(root)) continue;
    seen.add(root);
    const order: string[] = [root];
    const parent = new Map<string, string>();
    for (let i = 0; i < order.length; i++) {
      for (const v of adj.get(order[i]!) ?? []) {
        if (seen.has(v)) continue;
        seen.add(v);
        parent.set(v, order[i]!);
        order.push(v);
      }
    }
    // Pins in each subtree, children before parents.
    const below = new Map<string, string[]>();
    for (const u of order) below.set(u, [...(pinsAt.get(u) ?? [])]);
    for (let i = order.length - 1; i > 0; i--) {
      const u = order[i]!;
      const p = parent.get(u)!;
      below.get(p)!.push(...below.get(u)!);
      const a = points.get(p)!;
      const b = points.get(u)!;
      const pins = below.get(u)!;
      if (pins.length) edges.push({ a, b, length: Math.abs(a.x - b.x) + Math.abs(a.y - b.y), pins: [...pins] });
    }
  }
  return edges;
}

export function buildFlow(layout: Layout, nets: Record<string, { pins: string[] } | undefined>, twoPin: (refdes: string) => [string, string] | null): FlowGraph {
  const flowNets: FlowNet[] = [];
  for (const [net, polylines] of Object.entries(layout.wires)) {
    const pins = nets[net]?.pins ?? [];
    const pinsAt = new Map<string, string[]>();
    const pinPoints: Point[] = [];
    for (const pin of pins) {
      const at = layout.pins[pin]?.[0];
      if (!at) continue;
      pinPoints.push(at);
      const list = pinsAt.get(key(at)) ?? [];
      list.push(pin);
      pinsAt.set(key(at), list);
    }
    flowNets.push({ net, polylines, edges: netEdges(polylines, pinsAt, pinPoints) });
  }

  const bodies: FlowEdge[] = [];
  const done = new Set<string>();
  for (const sym of Object.values(layout.symbols)) {
    if (done.has(sym.refdes)) continue;
    done.add(sym.refdes);
    const pair = twoPin(sym.refdes);
    const a = pair && layout.pins[`${sym.refdes}.${pair[0]}`]?.[0];
    const b = pair && layout.pins[`${sym.refdes}.${pair[1]}`]?.[0];
    if (a && b) bodies.push({ a, b, length: Math.hypot(a.x - b.x, a.y - b.y), pins: [`${sym.refdes}.${pair![0]}`] });
  }
  return { nets: flowNets, bodies };
}
